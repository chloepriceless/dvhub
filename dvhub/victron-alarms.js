// Victron device-alarm catalog + decode (pure, IO-free).
//
// Read-only display feature: surfaces Victron's OWN device alarms/warnings
// (VE.Bus inverter + Battery/BMS) as a GUI banner, analogous to the Not-Halt
// banner. NOT a control path.
//
// Register source: official victronenergy/dbus_modbustcp `attributes.csv`
// (verified 2026-06-18). Alarm registers are uint16. Semantics per register:
//   0=Ok;1=Warning;2=Alarm   or   0=No alarm;2=Alarm   or boolean flags.
//
// The catalog is read via ONE block read per service (the alarm addresses are
// contiguous within a verified gap-free block); the poller indexes into the
// block by `addr - block.start`. See dvhub/polling.js pollVictronAlarms().

// VE.Bus /VebusError (reg 32) enum — non-zero = fault. Short German labels.
export const VEBUS_ERROR_TEXT = {
  1: 'Gerät abgeschaltet (andere Phase aus)',
  2: 'MK2-Typen gemischt',
  3: 'Nicht alle erwarteten Geräte gefunden',
  4: 'Kein weiteres Gerät erkannt',
  5: 'Überspannung an AC-Ausgang',
  6: 'Fehler im DDC-Programm',
  7: 'VE.Bus BMS verbunden, aber Assistant fehlt',
  10: 'Zeit-Synchronisationsproblem',
  14: 'Gerät kann keine Daten senden',
  16: 'Dongle fehlt',
  17: 'Master ausgefallen, Slave übernahm',
  18: 'AC-Überspannung am Slave-Ausgang',
  22: 'Gerät kann nicht als Slave arbeiten',
  24: 'Umschalt-Schutz ausgelöst',
  25: 'Firmware-Inkompatibilität',
  26: 'Interner Fehler'
};

// `kind` decode semantics:
//   'ova'        → 0=ok, 1=Warnung (sev1), >=2=Alarm (sev2)
//   'na'         → 0=ok, else Alarm (sev2)              [0=No alarm;2=Alarm]
//   'pre'        → 0=ok, 1=Vor-Alarm (sev1), >=2=Alarm (sev2)  [BmsPreAlarm/LowCellVoltage]
//   'bool'       → 0=ok, else Alarm (sev2)              [Bms/Error 0=No;1=Yes]
//   'vebusError' → 0=ok, else Alarm (sev2) + Enum-Klartext
export const VEBUS_BLOCK = { start: 31, count: 64 }; // 31..94 (gap-free block-read verified)
export const VEBUS_CATALOG = [
  { addr: 32, key: 'vebus.error', label: 'VE.Bus-Fehler', kind: 'vebusError' },
  { addr: 34, key: 'vebus.highTemp', label: 'Wechselrichter: Übertemperatur', kind: 'ova' },
  { addr: 35, key: 'vebus.lowBattery', label: 'Wechselrichter: Batterie schwach', kind: 'ova' },
  { addr: 36, key: 'vebus.overload', label: 'Wechselrichter: Überlast', kind: 'ova' },
  { addr: 42, key: 'vebus.tempSensor', label: 'Temperatursensor-Fehler', kind: 'ova' },
  { addr: 43, key: 'vebus.voltSensor', label: 'Spannungssensor-Fehler', kind: 'ova' },
  { addr: 60, key: 'vebus.bmsError', label: 'VE.Bus BMS-Fehler', kind: 'bool' },
  { addr: 64, key: 'vebus.gridLost', label: 'Netz verloren (GridLost)', kind: 'na' },
  { addr: 94, key: 'vebus.bmsPreAlarm', label: 'BMS Vor-Alarm', kind: 'pre' }
];

export const BATTERY_BLOCK = { start: 267, count: 63 }; // 267..329 (gap-free block-read verified)
export const BATTERY_CATALOG = [
  { addr: 267, key: 'batt.alarm', label: 'Batterie: allgemeiner Alarm', kind: 'na' },
  { addr: 268, key: 'batt.lowVoltage', label: 'Batterie: Unterspannung', kind: 'na' },
  { addr: 269, key: 'batt.highVoltage', label: 'Batterie: Überspannung', kind: 'na' },
  { addr: 272, key: 'batt.lowSoc', label: 'Batterie: Ladezustand niedrig', kind: 'na' },
  { addr: 273, key: 'batt.lowTemp', label: 'Batterie: Untertemperatur', kind: 'na' },
  { addr: 274, key: 'batt.highTemp', label: 'Batterie: Übertemperatur', kind: 'na' },
  { addr: 275, key: 'batt.midVoltage', label: 'Batterie: Mittenspannungs-Abweichung', kind: 'na' },
  { addr: 278, key: 'batt.fuseBlown', label: 'Batterie: Sicherung ausgelöst', kind: 'na' },
  { addr: 279, key: 'batt.highInternalTemp', label: 'Batterie: interne Übertemperatur', kind: 'na' },
  { addr: 320, key: 'batt.highChargeCurrent', label: 'Batterie: Ladestrom zu hoch', kind: 'na' },
  { addr: 321, key: 'batt.highDischargeCurrent', label: 'Batterie: Entladestrom zu hoch', kind: 'na' },
  { addr: 322, key: 'batt.cellImbalance', label: 'Batterie: Zell-Ungleichgewicht', kind: 'na' },
  { addr: 323, key: 'batt.internalFailure', label: 'Batterie: interner Fehler', kind: 'na' },
  { addr: 324, key: 'batt.highChargeTemp', label: 'Batterie: Ladetemperatur zu hoch', kind: 'na' },
  { addr: 325, key: 'batt.lowChargeTemp', label: 'Batterie: Ladetemperatur zu niedrig', kind: 'na' },
  { addr: 326, key: 'batt.lowCellVoltage', label: 'Batterie: Zellspannung niedrig', kind: 'pre' }, // 1=fast leer
  { addr: 327, key: 'batt.bmsCable', label: 'Batterie: BMS-Kabel', kind: 'ova' },
  { addr: 328, key: 'batt.contactor', label: 'Batterie: Schütz', kind: 'ova' },
  { addr: 329, key: 'batt.highCurrent', label: 'Batterie: Strom zu hoch', kind: 'ova' }
];

// ── MQTT/dbus-Variante desselben Katalogs (T-MQTT-ALARMS, 2026-07-25) ────────
// Für den Weg über den MQTT-Dienst der Anlage gibt es keine Registerblöcke,
// sondern dbus-Pfade. Die Pfadliste ist NICHT geraten: sie stammt aus einem
// Live-Dump des Ekrano GX (Venus 3.73) am 2026-07-25 — subscribe auf
// N/<portal>/vebus/+/Alarms/# bzw. .../battery/+/Alarms/# nach einem Keepalive.
// Schlüssel und Beschriftungen sind identisch zum Register-Katalog, damit das
// Banner unabhängig vom Transport gleich aussieht; die verifizierten Extras
// (Ripple, DC-Spannung/-Strom, Lade-/Entladesperre) haben eigene Schlüssel.
export const VEBUS_DBUS_CATALOG = [
  { path: 'VebusError', key: 'vebus.error', label: 'VE.Bus-Fehler', kind: 'vebusError' },
  { path: 'Alarms/HighTemperature', key: 'vebus.highTemp', label: 'Wechselrichter: Übertemperatur', kind: 'ova' },
  { path: 'Alarms/LowBattery', key: 'vebus.lowBattery', label: 'Wechselrichter: Batterie schwach', kind: 'ova' },
  { path: 'Alarms/Overload', key: 'vebus.overload', label: 'Wechselrichter: Überlast', kind: 'ova' },
  { path: 'Alarms/TemperatureSensor', key: 'vebus.tempSensor', label: 'Temperatursensor-Fehler', kind: 'ova' },
  { path: 'Alarms/VoltageSensor', key: 'vebus.voltSensor', label: 'Spannungssensor-Fehler', kind: 'ova' },
  { path: 'Alarms/GridLost', key: 'vebus.gridLost', label: 'Netz verloren (GridLost)', kind: 'na' },
  { path: 'Alarms/BmsPreAlarm', key: 'vebus.bmsPreAlarm', label: 'BMS Vor-Alarm', kind: 'pre' },
  { path: 'Alarms/BmsConnectionLost', key: 'vebus.bmsConnectionLost', label: 'VE.Bus: BMS-Verbindung verloren', kind: 'na' },
  { path: 'Alarms/Ripple', key: 'vebus.ripple', label: 'Wechselrichter: DC-Welligkeit', kind: 'ova' },
  { path: 'Alarms/HighDcVoltage', key: 'vebus.highDcVoltage', label: 'Wechselrichter: DC-Überspannung', kind: 'ova' },
  { path: 'Alarms/HighDcCurrent', key: 'vebus.highDcCurrent', label: 'Wechselrichter: DC-Strom zu hoch', kind: 'ova' },
  { path: 'Alarms/PhaseRotation', key: 'vebus.phaseRotation', label: 'Wechselrichter: Phasenfolge', kind: 'ova' }
];

export const BATTERY_DBUS_CATALOG = [
  { path: 'Alarms/Alarm', key: 'batt.alarm', label: 'Batterie: allgemeiner Alarm', kind: 'na' },
  { path: 'Alarms/LowVoltage', key: 'batt.lowVoltage', label: 'Batterie: Unterspannung', kind: 'na' },
  { path: 'Alarms/HighVoltage', key: 'batt.highVoltage', label: 'Batterie: Überspannung', kind: 'na' },
  { path: 'Alarms/LowSoc', key: 'batt.lowSoc', label: 'Batterie: Ladezustand niedrig', kind: 'na' },
  { path: 'Alarms/LowTemperature', key: 'batt.lowTemp', label: 'Batterie: Untertemperatur', kind: 'na' },
  { path: 'Alarms/HighTemperature', key: 'batt.highTemp', label: 'Batterie: Übertemperatur', kind: 'na' },
  { path: 'Alarms/HighChargeCurrent', key: 'batt.highChargeCurrent', label: 'Batterie: Ladestrom zu hoch', kind: 'na' },
  { path: 'Alarms/HighDischargeCurrent', key: 'batt.highDischargeCurrent', label: 'Batterie: Entladestrom zu hoch', kind: 'na' },
  { path: 'Alarms/CellImbalance', key: 'batt.cellImbalance', label: 'Batterie: Zell-Ungleichgewicht', kind: 'na' },
  { path: 'Alarms/InternalFailure', key: 'batt.internalFailure', label: 'Batterie: interner Fehler', kind: 'na' },
  { path: 'Alarms/HighChargeTemperature', key: 'batt.highChargeTemp', label: 'Batterie: Ladetemperatur zu hoch', kind: 'na' },
  { path: 'Alarms/LowChargeTemperature', key: 'batt.lowChargeTemp', label: 'Batterie: Ladetemperatur zu niedrig', kind: 'na' },
  { path: 'Alarms/LowCellVoltage', key: 'batt.lowCellVoltage', label: 'Batterie: Zellspannung niedrig', kind: 'pre' },
  { path: 'Alarms/HighCellVoltage', key: 'batt.highCellVoltage', label: 'Batterie: Zellspannung hoch', kind: 'na' },
  { path: 'Alarms/ChargeBlocked', key: 'batt.chargeBlocked', label: 'Batterie: Laden gesperrt', kind: 'na' },
  { path: 'Alarms/DischargeBlocked', key: 'batt.dischargeBlocked', label: 'Batterie: Entladen gesperrt', kind: 'na' }
];

// decodeAlarmValue: raw register value → { severity:0|1|2, active, text }
export function decodeAlarmValue(entry, raw) {
  const v = Number.isFinite(Number(raw)) ? Number(raw) : 0;
  let severity = 0;
  let text = null;
  switch (entry.kind) {
    case 'ova':
    case 'pre':
      severity = v <= 0 ? 0 : (v === 1 ? 1 : 2);
      break;
    case 'na':
    case 'bool':
      severity = v <= 0 ? 0 : 2;
      break;
    case 'vebusError':
      if (v !== 0) { severity = 2; text = VEBUS_ERROR_TEXT[v] || `Fehler-Code ${v}`; }
      break;
    default:
      severity = v <= 0 ? 0 : 2;
  }
  return { severity, active: severity > 0, text };
}

function scanBlock(block, blockStart, catalog, unitLabel, prevByKey, nowIso, out) {
  if (!Array.isArray(block)) return; // null = read failed / unit absent → contribute nothing
  for (const e of catalog) {
    const idx = e.addr - blockStart;
    if (idx < 0 || idx >= block.length) continue;
    const dec = decodeAlarmValue(e, block[idx]);
    if (!dec.active) continue;
    out.push({
      key: e.key,
      label: e.label,
      severity: dec.severity,
      text: dec.text || null,
      unit: unitLabel,
      raw: Number(block[idx]) || 0,
      // latch first-seen timestamp across polls; reset implicitly when the
      // alarm clears (no prev entry → fresh `since` on re-trigger).
      since: (prevByKey[e.key] && prevByKey[e.key].since) || nowIso
    });
  }
}

// buildActiveAlarms: block arrays (or null) → sorted active-alarm list.
//   unitsRaw = { vebus: number[]|null, battery: number[]|null }
//   prevActive = previous active[] (for `since` latch)
//   now = epoch ms
export function buildActiveAlarms(unitsRaw, prevActive, now) {
  const nowIso = new Date(now).toISOString();
  const prevByKey = {};
  for (const a of (prevActive || [])) { if (a && a.key) prevByKey[a.key] = a; }
  const out = [];
  scanBlock(unitsRaw && unitsRaw.vebus, VEBUS_BLOCK.start, VEBUS_CATALOG, 'vebus', prevByKey, nowIso, out);
  scanBlock(unitsRaw && unitsRaw.battery, BATTERY_BLOCK.start, BATTERY_CATALOG, 'battery', prevByKey, nowIso, out);
  out.sort((a, b) => (b.severity - a.severity) || a.key.localeCompare(b.key));
  return out;
}

// buildActiveAlarmsFromDbus: dieselbe Ausgabe wie buildActiveAlarms, nur aus
// dbus-Pfaden statt Registerblöcken (MQTT-Transport, T-MQTT-ALARMS 2026-07-25).
//   values = { vebus: {<pfad>: raw}, battery: {<pfad>: raw} } — ein FEHLENDER Pfad
//   trägt nichts bei (Gerät kennt ihn nicht), und ein Pfad mit null trägt ebenfalls
//   nichts bei: Venus publiziert für nicht unterstützte Alarme `null`, und das als
//   0 („alles gut") zu lesen wäre ein stiller Fehlalarm-in-die-andere-Richtung.
export function buildActiveAlarmsFromDbus(values, prevActive, now) {
  const nowIso = new Date(now).toISOString();
  const prevByKey = {};
  for (const a of (prevActive || [])) { if (a && a.key) prevByKey[a.key] = a; }
  const out = [];
  const scan = (map, catalog, unitLabel) => {
    if (!map || typeof map !== 'object') return;
    for (const e of catalog) {
      if (!(e.path in map)) continue;
      const raw = map[e.path];
      if (raw == null) continue;
      const dec = decodeAlarmValue(e, raw);
      if (!dec.active) continue;
      out.push({
        key: e.key, label: e.label, severity: dec.severity, text: dec.text || null,
        unit: unitLabel, raw: Number(raw) || 0,
        since: (prevByKey[e.key] && prevByKey[e.key].since) || nowIso
      });
    }
  };
  scan(values && values.vebus, VEBUS_DBUS_CATALOG, 'vebus');
  scan(values && values.battery, BATTERY_DBUS_CATALOG, 'battery');
  out.sort((a, b) => (b.severity - a.severity) || a.key.localeCompare(b.key));
  return out;
}

export function maxSeverity(active) {
  return (active || []).reduce((m, a) => Math.max(m, (a && a.severity) || 0), 0);
}

// buildVictronAlarmsPayload: read-side shaping for /api/status.
// Takes the raw alarm state (state.victron.alarms, arrived via the IPC runtime
// snapshot — NOT web-process-local state) + now(ms) + the configured poll
// interval, and returns the banner payload WITH a staleness flag.
//
// Staleness matters for a safety-facing banner: if the alarm poll dies, the
// last-known alarms must NOT keep masquerading as live truth. When stale, the
// frontend degrades to a neutral "Überwachung veraltet" state instead of a
// trusted green/yellow/red verdict (a stale "all-OK" is more dangerous than no
// banner at all).
export function buildVictronAlarmsPayload(alarmsState, now, pollIntervalMs) {
  const a = alarmsState && typeof alarmsState === 'object' ? alarmsState : null;
  if (!a || a.configured === false) {
    // alarm polling not configured (no unit ids) → no banner, not "OK"
    return { configured: false, active: [], updatedAt: null, ageMs: null, stale: false, severity: 0 };
  }
  const active = Array.isArray(a.active) ? a.active : [];
  const updatedAt = a.updatedAt || null;
  const ageMs = updatedAt ? Math.max(0, now - new Date(updatedAt).getTime()) : null;
  // stale once the last successful read is older than 3× the poll interval
  // (floor 90 s) — covers a couple of missed cycles before degrading.
  const staleThreshold = Math.max(90000, (Number(pollIntervalMs) || 30000) * 3);
  const stale = ageMs == null || ageMs > staleThreshold;
  return {
    configured: true,
    active,
    updatedAt,
    ageMs,
    stale,
    severity: maxSeverity(active)
  };
}
