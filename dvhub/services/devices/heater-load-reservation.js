// services/devices/heater-load-reservation.js — erwarteter Heizstab-Verbrauch in
// der Lastprognose für EOS. REIN (keine I/O), unit-testbar.
//
// EOS kann neben dem Akku nur EIN stufenlos regelbares Gerät planen (das Auto).
// Ein Heizstab („modulating“) wird darum von DVhub selbst nach Überschuss
// geregelt (eos-device-bridge.js) — EOS wusste bisher nichts von ihm und
// verplante denselben PV-Überschuss für Akku, Auto oder Einspeisung; erst im
// nächsten Lauf fiel die geringere Einspeisung auf (2026-10-04).
//
// Hier wird sein erwarteter Verbrauch als zusätzliche Last in die Prognose
// gelegt, damit EOS ihn von vornherein einrechnet:
//   - je Kalendertag höchstens die Speicherenergie des Heizstabs
//     (plan.capacityWh, heute abzüglich der schon gelieferten Energie),
//   - nur in Stunden mit erwartetem PV-Überschuss (PV-Prognose > Last),
//   - je Stunde höchstens der Überschuss und höchstens plan.maxPowerW,
//   - zuerst die Stunden mit dem niedrigsten Einspeisewert (dort kostet die
//     Wärme am wenigsten Erlös), bei gleichem Wert die mit dem meisten Überschuss.
// Ohne capacityWh gibt es keine belastbare Tagesmenge → keine Vorhaltung.

const HOUR_MS = 3_600_000;

const toMs = (v) => (v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : Date.parse(v)));
const slotStartMs = (slot) => toMs(slot?.start ?? slot?.ts);
const slotPowerW = (slot) => Number(slot?.powerW ?? slot?.watts ?? 0) || 0;

/** Mittlere Leistung je voller Stunde aus Slots beliebiger Auflösung. */
function hourlyMean(slots) {
  const sum = new Map();
  const count = new Map();
  for (const slot of Array.isArray(slots) ? slots : []) {
    const ms = slotStartMs(slot);
    if (!Number.isFinite(ms)) continue;
    const hour = Math.floor(ms / HOUR_MS) * HOUR_MS;
    sum.set(hour, (sum.get(hour) || 0) + slotPowerW(slot));
    count.set(hour, (count.get(hour) || 0) + 1);
  }
  const out = new Map();
  for (const [hour, total] of sum) out.set(hour, total / count.get(hour));
  return out;
}

/**
 * @param {object} args
 * @param {Array<{start:string|Date, powerW:number}>} args.loadSlots  stündliche Lastprognose (W)
 * @param {Array<{start:string|Date, powerW:number}>} args.pvSlots    PV-Prognose (W, beliebige Auflösung)
 * @param {Array<{id:string, maxPowerW:number, minPowerW?:number, capacityWh:number}>} args.heaters
 * @param {Array<{start:string|Date, powerW:number}>} [args.feedInSlots] Einspeisewert je Slot (beliebige Einheit, nur Rangfolge)
 * @param {(ms:number)=>string} args.localDateOf   'YYYY-MM-DD' in der Anlagen-Zeitzone
 * @param {number} args.nowMs
 * @param {Record<string,{date:string, wh:number}>} [args.deliveredToday] je Heizstab heute schon gelieferte Wh
 * @returns {{ slots: Array, reservedWh: number, byDay: Record<string, number> }}
 *   slots = loadSlots mit erhöhter powerW (und heaterW) in den reservierten Stunden
 */
export function reserveHeaterLoad({ loadSlots, pvSlots, heaters, feedInSlots = [], localDateOf, nowMs, deliveredToday = {} }) {
  const slots = Array.isArray(loadSlots) ? loadSlots.map((slot) => ({ ...slot })) : [];
  const usable = (Array.isArray(heaters) ? heaters : []).filter((h) => Number(h?.maxPowerW) > 0 && Number(h?.capacityWh) > 0);
  if (!slots.length || !usable.length || typeof localDateOf !== 'function') return { slots, reservedWh: 0, byDay: {} };

  const pvByHour = hourlyMean(pvSlots);
  const feedInByHour = hourlyMean(feedInSlots);
  const currentHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const today = localDateOf(nowMs);

  // Künftige Stunden je Tag sammeln.
  const byDayIndex = new Map();
  slots.forEach((slot, index) => {
    const ms = slotStartMs(slot);
    if (!Number.isFinite(ms) || ms < currentHour) return;
    const day = localDateOf(ms);
    if (!byDayIndex.has(day)) byDayIndex.set(day, []);
    byDayIndex.get(day).push({ index, ms });
  });

  const byDay = {};
  let reservedWh = 0;
  for (const [day, hours] of byDayIndex) {
    // Überschuss je Stunde, bevor irgendein Heizstab etwas bekommt.
    const candidates = hours.map(({ index, ms }) => {
      const hour = Math.floor(ms / HOUR_MS) * HOUR_MS;
      return {
        index,
        surplusW: Math.max(0, (pvByHour.get(hour) || 0) - slotPowerW(slots[index])),
        feedIn: feedInByHour.has(hour) ? feedInByHour.get(hour) : Infinity
      };
    }).filter((c) => c.surplusW > 0);
    if (!candidates.length) continue;
    candidates.sort((a, b) => (a.feedIn - b.feedIn) || (b.surplusW - a.surplusW) || (a.index - b.index));

    for (const heater of usable) {
      const delivered = day === today && deliveredToday?.[heater.id]?.date === today
        ? Math.max(0, Number(deliveredToday[heater.id].wh) || 0)
        : 0;
      let budgetWh = Math.max(0, Number(heater.capacityWh) - delivered);
      const maxW = Number(heater.maxPowerW);
      const minW = Math.max(0, Number(heater.minPowerW) || 0);
      for (const c of candidates) {
        if (budgetWh <= 0) break;
        const powerW = Math.min(maxW, c.surplusW, budgetWh); // 1 h je Slot: W ≙ Wh
        if (powerW <= 0 || powerW < minW) continue;
        const slot = slots[c.index];
        slot.powerW = slotPowerW(slot) + powerW;
        slot.heaterW = (slot.heaterW || 0) + powerW;
        c.surplusW -= powerW;
        budgetWh -= powerW;
        reservedWh += powerW;
        byDay[day] = (byDay[day] || 0) + powerW;
      }
    }
  }
  for (const day of Object.keys(byDay)) byDay[day] = Math.round(byDay[day]);
  return { slots, reservedWh: Math.round(reservedWh), byDay };
}
