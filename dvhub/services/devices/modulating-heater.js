// services/devices/modulating-heater.js -- Leistungsregelung für modulierende
// Heizstäbe (MYPV Elwa / AC Thor). REIN (keine I/O), unit-testbar.
//
// Warum DVhub-seitig statt EOS-nativ (Phase-0-Befund): EOS' genetic-Solver kann
// nur EIN EV-artiges Gerät (= das Auto). Ein modulierender Heizstab kann daher
// nicht als 2. EV co-optimiert werden. Er wird deshalb hier geregelt — genau wie
// die Geräte es nativ tun: dem PV-Überschuss folgen (echte Leistungsmodulation),
// mit Deadline-Boost, um ein Ziel (z. B. Warmwasser) rechtzeitig zu erreichen.
// „Mitplanen mit seiner Leistung": der Verbrauch senkt die Einspeisung, worauf
// der EOS-Akkuplan im nächsten 15-min-Takt reagiert; die erwartete Energie liefert
// expectedHeaterEnergyWh() für optionale Last-Vorhaltung.

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Ziel-Leistung des Heizstabs im aktuellen Moment.
 *
 * @param {object} args
 * @param {number} args.maxPowerW           Max. Heizleistung
 * @param {number} [args.minPowerW=0]        Unter dieser Leistung nicht laufen (außer Deadline zwingt)
 * @param {number} args.surplusW             Aktueller PV-Überschuss (W, ≥0; = Einspeisung + aktuelle Heizlast)
 * @param {number|null} [args.socPct]        Geschätzter/gemessener thermischer Füllstand 0..100 (null=unbekannt)
 * @param {number|null} [args.targetPct]     Ziel-Füllstand (null=kein Ziel → nur Überschuss folgen)
 * @param {number|null} [args.capacityWh]    Thermische Kapazität (für Deadline-Rechnung)
 * @param {number|null} [args.deadlineMs]    „fertig bis" (UTC-ms; null=keine)
 * @param {number} [args.nowMs]
 * @returns {{ powerW:number, reason:string }}
 */
export function computeHeaterPowerW(args) {
  const maxPowerW = Math.max(0, Number(args.maxPowerW) || 0);
  const minPowerW = clamp(Number(args.minPowerW) || 0, 0, maxPowerW);
  const surplusW = Math.max(0, Number(args.surplusW) || 0);
  const socPct = args.socPct == null ? null : Number(args.socPct);
  const targetPct = args.targetPct == null ? null : Number(args.targetPct);
  const capacityWh = args.capacityWh == null ? null : Number(args.capacityWh);
  const deadlineMs = args.deadlineMs == null ? null : Number(args.deadlineMs);
  const nowMs = Number(args.nowMs) || Date.now();

  if (maxPowerW <= 0) return { powerW: 0, reason: 'disabled' };

  // Ziel erreicht → aus.
  if (socPct != null && targetPct != null && socPct >= targetPct) {
    return { powerW: 0, reason: 'target_reached' };
  }

  // Basis: dem Überschuss folgen.
  let powerW = clamp(surplusW, 0, maxPowerW);
  let reason = 'surplus_follow';

  // Deadline-Boost: reicht der erwartete Überschuss nicht, um das Ziel bis zur
  // Deadline zu erreichen, mit (auch netzgestützter) Mehrleistung hochfahren.
  if (targetPct != null && socPct != null && capacityWh != null && capacityWh > 0 && deadlineMs != null && deadlineMs > nowMs) {
    const energyNeededWh = Math.max(0, (targetPct - socPct) / 100 * capacityWh);
    const timeLeftH = (deadlineMs - nowMs) / 3600_000;
    if (energyNeededWh > 0 && timeLeftH > 0) {
      const requiredW = energyNeededWh / timeLeftH;
      if (requiredW > powerW) { powerW = clamp(requiredW, powerW, maxPowerW); reason = 'deadline_boost'; }
    }
  }

  // Nicht unter Mindestleistung tröpfeln (außer der Deadline-Boost verlangt es).
  if (reason !== 'deadline_boost' && powerW > 0 && powerW < minPowerW) {
    return { powerW: 0, reason: 'below_min' };
  }
  return { powerW: Math.round(powerW), reason };
}

/**
 * Erwartete Restenergie (Wh) bis zum Ziel — für optionale Last-Vorhaltung/Anzeige.
 * @returns {number} Wh (0, wenn kein Ziel/Füllstand bekannt oder Ziel erreicht)
 */
export function expectedHeaterEnergyWh({ socPct = null, targetPct = null, capacityWh = null }) {
  if (socPct == null || targetPct == null || capacityWh == null) return 0;
  return Math.max(0, (Number(targetPct) - Number(socPct)) / 100 * Number(capacityWh));
}
