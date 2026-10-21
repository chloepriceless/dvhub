/**
 * multi-gx/follower-controller.js — Regler fuer eine zweite Victron-GX-Anlage
 * am selben Netzanschluss (ohne PV, ohne eigenen Zaehler; Chrissi 21.10.2026).
 *
 * Die Hauptanlage hat den Zaehler am Hausanschluss und regelt den Anschluss wie
 * bisher schnell auf DVhubs Netz-Sollwert. Die zweite Anlage sieht nur ihren
 * eigenen AC-IN; ihr Netz-Sollwert (2716/2717) ist deshalb faktisch der Sollwert
 * fuer die Leistung, die sie aus dem Hausnetz zieht (+) oder hineinschiebt (−).
 *
 * Geregelt wird nicht das Netzziel, sondern der Anteil der zweiten Anlage an der
 * GESAMTEN Akkuleistung beider Anlagen. Diese Summe ist von der Aufteilung
 * unabhaengig: schiebt die zweite Anlage mehr ins Hausnetz, gleicht die
 * Hauptanlage das am Zaehler sofort aus und entlaedt entsprechend weniger. Die
 * beiden Regelkreise ziehen also nicht an derselben Groesse — die Hauptanlage
 * regelt das Netz, die zweite nur die Verteilung, und zwar traege (gemittelte
 * Summe, Totband, Rampe, halbe Abweichung je Takt).
 *
 * Der Anteil folgt der nutzbaren Energie: beim Entladen dem Inhalt ueber dem
 * Mindest-SoC, beim Laden dem freien Platz bis Max-SoC. Damit gleichen sich die
 * Ladestaende an und EOS darf beide Akkus als einen planen. (Der KI-Vorschlag vom
 * 26.09. verteilte das Netzziel; bei „Null am Zaehler“ lag der zweite Akku dann
 * brach, waehrend sich die Hauptanlage allein leerte.)
 *
 * Ungedeckter Bedarf (Codex-Gegenpruefung 21.10.): Ist die Hauptanlage leer oder
 * an ihrer Leistungsgrenze, zeigt sich der Rest nicht in der Akku-Summe, sondern
 * als Netzbezug ueber ihrem Sollwert (`unmetW`, vom Aufrufer nur in diesen
 * Faellen gesetzt). Er zaehlt zur Summe dazu, sonst bliebe ein voller zweiter
 * Akku untaetig, waehrend das Haus aus dem Netz bezieht.
 *
 * Der Sollwert wirkt auf den AC-IN, nicht auf den Akku: haengen Verbraucher an
 * der zweiten Anlage, zieht sie deren Leistung zusaetzlich. Nach oben ist der
 * Sollwert deshalb um die GEMESSENE eigene Last weiter (AC-IN − Akku,
 * `followerAcInW`). Und er bleibt an der Leine des gemessenen AC-IN: drosselt
 * das BMS, laeuft er nicht davon und springt nach der Freigabe nicht hoch
 * (Codex-Gegenpruefung Runde 2: ohne Leine 77 kW nach sechs Minuten).
 * `unmetW` ist vorzeichenbehaftet: − = Ladebedarf, den die Hauptanlage nicht
 * aufnehmen kann (voll oder an der Ladegrenze).
 *
 * Vorzeichen wie in DVhub: + = Laden/Bezug, − = Entladen/Einspeisen. Ganze Watt,
 * kein -0. `nowMs` ist die einzige Zeitquelle.
 *
 * @module services/multi-gx/follower-controller
 */

export const DEFAULT_RAMP_W_PER_S = 200;
export const DEFAULT_DEADBAND_W = 300;
export const DEFAULT_GAIN = 0.5;
export const DEFAULT_FILTER_S = 30;
const LEASH_W = 1000;

function power(value, name) {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  if (!Number.isFinite(n) || n < 0) throw new TypeError(`multi-gx: ${name} muss eine Zahl >= 0 sein (ist ${String(value)})`);
  return n;
}

function nonNeg(value, fallback) {
  const n = Number(value);
  return value != null && Number.isFinite(n) && n >= 0 ? n : fallback;
}

function watt(v) {
  const r = Math.round(v);
  return r === 0 ? 0 : r;
}

const finite = (v) => v != null && Number.isFinite(Number(v));

// Nutzbare Energie einer Seite in Wh fuer die Richtung (Entladen: ueber Min-SoC,
// Laden: bis Max-SoC). null, wenn Angaben fehlen.
function usableWh(side, charging) {
  if (!side || !finite(side.socPct) || !finite(side.capacityWh)) return null;
  const soc = Number(side.socPct);
  const min = finite(side.minSocPct) ? Number(side.minSocPct) : 0;
  const max = finite(side.maxSocPct) ? Number(side.maxSocPct) : 100;
  const pct = charging ? max - soc : soc - min;
  return Math.max(0, pct) / 100 * Number(side.capacityWh);
}

/**
 * @param {object} config
 * @param {number} config.maxChargeW       Ladeleistung der zweiten Anlage (W)
 * @param {number} config.maxDischargeW    Entladeleistung der zweiten Anlage (W)
 * @param {number} [config.rampWPerS=200]  hoechste Sollwert-Aenderung je Sekunde
 * @param {number} [config.deadbandW=300]  kleinere Abweichungen bleiben stehen
 * @param {number} [config.gain=0.5]       Anteil der Abweichung, der je Takt ausgeglichen wird
 * @param {number} [config.filterS=30]     Zeitkonstante der gemittelten Gesamtleistung
 */
export function createFollowerController(config = {}) {
  const maxChargeW = power(config.maxChargeW, 'maxChargeW');
  const maxDischargeW = power(config.maxDischargeW, 'maxDischargeW');
  const rampWPerS = nonNeg(config.rampWPerS, DEFAULT_RAMP_W_PER_S);
  const deadbandW = nonNeg(config.deadbandW, DEFAULT_DEADBAND_W);
  const gainRaw = nonNeg(config.gain, DEFAULT_GAIN);
  const gain = gainRaw > 0 && gainRaw <= 1 ? gainRaw : DEFAULT_GAIN;
  const filterS = nonNeg(config.filterS, DEFAULT_FILTER_S);

  let setpoint = 0;       // AC-IN-Sollwert der zweiten Anlage (Gleitwert)
  let lastMs = null;
  let totalAvg = null;    // gemittelte Gesamt-Akkuleistung
  let last = null;

  function out(reason, desired = 0, weight = null) {
    const setpointW = watt(setpoint);
    if (setpointW === 0) setpoint = 0;
    last = {
      setpointW,
      desiredFollowerBatteryW: watt(desired),
      followerWeightPct: weight == null ? null : Number((weight * 100).toFixed(1)),
      totalBatteryW: totalAvg == null ? null : watt(totalAvg),
      reason,
    };
    return { ...last };
  }

  function rampToward(target, dtS) {
    const max = rampWPerS * dtS;
    setpoint += Math.max(-max, Math.min(max, target - setpoint));
  }

  function tick(input = {}) {
    const nowMs = Number(input.nowMs);
    let dtS = 0;
    if (Number.isFinite(nowMs)) {
      dtS = lastMs == null ? 0 : Math.max(0, (nowMs - lastMs) / 1000);
      lastMs = nowMs;
    }

    if (input.online === false) { setpoint = 0; totalAvg = null; return out('follower_offline'); }
    if (input.stop === true) { setpoint = 0; return out('stop'); }

    if (!finite(input.primaryBatteryW) || !finite(input.followerBatteryW)) {
      rampToward(0, dtS);
      if (input.exportBlocked === true) setpoint = Math.max(0, setpoint);
      return out('no_data');
    }
    const followerW = Number(input.followerBatteryW);
    const unmetW = finite(input.unmetW) ? Number(input.unmetW) : 0;
    const totalW = Number(input.primaryBatteryW) + followerW - unmetW;
    // Eigene Last der zweiten Anlage: was sie ueber den AC-IN zieht, aber nicht
    // in den Akku geht — nur gemessen, nie aus dem eigenen Sollwert geschaetzt.
    const acInW = finite(input.followerAcInW) ? Number(input.followerAcInW) : null;
    const localLoadW = acInW == null ? 0 : Math.max(0, acInW - followerW);
    // Gleitender Mittelwert: kurze Lastspitzen sollen die Verteilung nicht bewegen.
    totalAvg = totalAvg == null || filterS === 0
      ? totalW
      : totalAvg + (totalW - totalAvg) * (1 - Math.exp(-dtS / filterS));

    const charging = totalAvg > 0;
    const f = usableWh(input.follower, charging);
    const p = usableWh(input.primary, charging);
    let weight;
    if (f == null || p == null) weight = 0;               // ohne SoC kein Anteil
    else if (f + p > 0) weight = f / (f + p);
    else weight = 0;                                      // beide leer bzw. voll
    // Was die Hauptanlage nicht leisten kann, geht ganz an die zweite Anlage —
    // nicht nur ihr Anteil (Codex Runde 3). Grenzen der Hauptanlage optional.
    let share = totalAvg * weight;
    const pDis = finite(input.primary?.maxDischargeW) ? Number(input.primary.maxDischargeW) : null;
    const pCh = finite(input.primary?.maxChargeW) ? Number(input.primary.maxChargeW) : null;
    if (totalAvg < 0 && pDis != null) share = Math.min(share, totalAvg + pDis);
    if (totalAvg > 0 && pCh != null) share = Math.max(share, totalAvg - pCh);
    const desired = Math.max(-maxDischargeW, Math.min(maxChargeW, share));

    let reason = 'ok';
    const err = desired - followerW;
    if (Math.abs(err) < deadbandW) reason = 'deadband';
    else if (dtS > 0) {
      const max = rampWPerS * dtS;
      setpoint += Math.max(-max, Math.min(max, err * gain));
      reason = 'follow';
    }
    // Leine: hoechstens LEASH_W vom gemessenen AC-IN entfernt (Anti-Windup) …
    if (acInW != null) {
      const leash = Math.max(LEASH_W, 2 * deadbandW);
      setpoint = Math.max(acInW - leash, Math.min(acInW + leash, setpoint));
    }
    // … und die harten Grenzen ZULETZT, damit die Leine sie nie aufweitet (Codex Runde 3).
    setpoint = Math.max(-maxDischargeW, Math.min(maxChargeW + localLoadW, setpoint));
    if (input.exportBlocked === true && setpoint < 0) { setpoint = 0; reason = 'export_blocked'; }
    else if (input.exportBlocked === true) reason = 'export_blocked';
    return out(reason, desired, weight);
  }

  function reset() { setpoint = 0; lastMs = null; totalAvg = null; last = null; }

  return {
    tick,
    reset,
    status: () => (last ? { ...last } : null),
    config: { maxChargeW, maxDischargeW, rampWPerS, deadbandW, gain, filterS },
  };
}
