// services/devices/schedulable.js -- planbare Verbraucher: Datenmodell,
// Validierung, Normalisierung (2026-09-26).
//
// Anlass (Christin): benutzerdefinierte planbare Geräte — verschiebbare An/Aus-
// Lasten (Geschirrspüler) und modulierende Heizstäbe (MYPV Elwa, AC Thor) — die
// EOS mitplant, mit Endpunkt-Zuordnung (Shelly / DVhub-MQTT-Expose / fremdes
// MQTT-Gerät). Dieses Modul ist REIN (keine I/O) und damit voll unit-testbar:
// es normalisiert/validiert einen Geräte-Config-Eintrag und liefert klare Fehler.
//
// Zwei Geräteklassen (Phase-0-Spike gegen EOS v0.4 bestätigt):
//   - "deferrable": An/Aus, feste Energie + Mindestlaufzeit, fertig bis Deadline.
//     EOS-nativ als home_appliance (consumption_wh + duration_h + deadline_datetime).
//   - "modulating": kontinuierliche Leistung 0..maxPowerW, folgt PV-Überschuss bis
//     Ziel/Deadline. EOS' genetic-Solver kann nur EIN EV-artiges Gerät (= das Auto),
//     daher wird der Heizstab DVhub-seitig moduliert und sein erwarteter Verbrauch
//     in die EOS-Last eingespeist (mitplanen ohne Single-EV-Konflikt).
//
// Endpunkt-Typen (wie vom Nutzer gewünscht):
//   - "mqtt_expose":  DVhub publiziert den gewollten Zustand unter
//                     <prefix>/device/<id>/desired (+ HA-Discovery), HA/Node-RED schaltet.
//   - "shelly":       DVhub schaltet direkt ein Shelly-Gerät (nur An/Aus).
//   - "mqtt_publish": DVhub publiziert an ein konfiguriertes fremdes Command-Topic
//                     (An/Aus-Payload bzw. Leistungs-Topic) — z. B. ein bereits
//                     über MQTT verfügbarer Schalter.

export const DEVICE_KINDS = Object.freeze(['deferrable', 'modulating']);
export const ENDPOINT_TYPES = Object.freeze(['mqtt_expose', 'shelly', 'mqtt_publish']);

const HHMM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Sanity-Obergrenzen (gegen Fehleingaben; nicht anlagenspezifisch).
const MAX_POWER_W = 30_000;
const MAX_ENERGY_WH = 100_000;
const MAX_DURATION_H = 24;
const MAX_CAPACITY_WH = 200_000;

function isObj(v) { return !!(v && typeof v === 'object' && !Array.isArray(v)); }
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/**
 * Ist dieser Config-Eintrag ein planbares Gerät? (Opt-in über schedulable:true.)
 */
export function isSchedulableDevice(d) {
  return isObj(d) && d.schedulable === true;
}

/**
 * Endpunkt-Typen, die für eine Geräteklasse zulässig sind.
 * Modulierend braucht Leistungssteuerung → Shelly (nur An/Aus) ist dort nur ein
 * grober Bang-Bang-Fallback und wird NICHT als zulässiger Endpunkt angeboten.
 */
export function allowedEndpointsForKind(kind) {
  if (kind === 'modulating') return ['mqtt_expose', 'mqtt_publish'];
  return ['mqtt_expose', 'shelly', 'mqtt_publish'];
}

function validateEndpoint(ep, kind, errs) {
  if (!isObj(ep)) { errs.push('endpoint fehlt'); return null; }
  const type = String(ep.type || '');
  if (!ENDPOINT_TYPES.includes(type)) { errs.push('endpoint.type ungültig'); return null; }
  if (!allowedEndpointsForKind(kind).includes(type)) {
    errs.push(`endpoint.type ${type} für kind ${kind} nicht erlaubt`);
    return null;
  }
  const out = { type };
  if (type === 'shelly') {
    // Referenz auf ein vorhandenes schaltbares Gerät (dessen id) oder ein Host.
    const ref = String(ep.shellyDeviceId || '').trim();
    if (!ref) { errs.push('endpoint.shellyDeviceId erforderlich'); return null; }
    if (!ID_RE.test(ref)) { errs.push('endpoint.shellyDeviceId ungültig'); return null; }
    out.shellyDeviceId = ref;
  } else if (type === 'mqtt_publish') {
    const cmd = String(ep.commandTopic || '').trim();
    const powerTopic = String(ep.powerTopic || '').trim();
    if (kind === 'modulating') {
      if (!powerTopic) { errs.push('endpoint.powerTopic erforderlich (modulierend)'); return null; }
      out.powerTopic = powerTopic;
      // optionaler Template-Platzhalter {value} für die Leistungs-Payload
      out.powerTemplate = typeof ep.powerTemplate === 'string' && ep.powerTemplate ? ep.powerTemplate : '{value}';
    } else {
      if (!cmd) { errs.push('endpoint.commandTopic erforderlich (An/Aus)'); return null; }
      out.commandTopic = cmd;
      out.onPayload = ep.onPayload != null ? String(ep.onPayload) : 'ON';
      out.offPayload = ep.offPayload != null ? String(ep.offPayload) : 'OFF';
    }
    // MQTT-Wildcards in Publish-Topics sind unzulässig.
    for (const t of [out.commandTopic, out.powerTopic]) {
      if (t && /[+#]/.test(t)) { errs.push('endpoint-Topic darf keine MQTT-Wildcards (+/#) enthalten'); return null; }
    }
  }
  // mqtt_expose: keine weiteren Pflichtfelder (DVhub publiziert unter fester ID).
  return out;
}

function validateDeferrablePlan(p, errs) {
  const energyWh = numOrNull(p.energyWh);
  const durationH = numOrNull(p.durationH);
  if (energyWh == null || energyWh <= 0 || energyWh > MAX_ENERGY_WH) errs.push('plan.energyWh muss 1..' + MAX_ENERGY_WH + ' sein');
  if (durationH == null || durationH <= 0 || durationH > MAX_DURATION_H) errs.push('plan.durationH muss >0..' + MAX_DURATION_H + ' sein');
  const out = { energyWh, durationH };
  if (p.deadline != null && String(p.deadline) !== '') {
    if (!HHMM_RE.test(String(p.deadline))) errs.push('plan.deadline muss HH:MM sein'); else out.deadline = String(p.deadline).padStart(5, '0');
  }
  if (p.earliestStart != null && String(p.earliestStart) !== '') {
    if (!HHMM_RE.test(String(p.earliestStart))) errs.push('plan.earliestStart muss HH:MM sein'); else out.earliestStart = String(p.earliestStart).padStart(5, '0');
  }
  return out;
}

function validateModulatingPlan(p, errs) {
  const maxPowerW = numOrNull(p.maxPowerW);
  if (maxPowerW == null || maxPowerW <= 0 || maxPowerW > MAX_POWER_W) errs.push('plan.maxPowerW muss 1..' + MAX_POWER_W + ' sein');
  const out = { maxPowerW };
  const minPowerW = numOrNull(p.minPowerW);
  out.minPowerW = (minPowerW != null && minPowerW >= 0 && minPowerW < (maxPowerW || Infinity)) ? minPowerW : 0;
  const capacityWh = numOrNull(p.capacityWh);
  if (capacityWh != null) {
    if (capacityWh <= 0 || capacityWh > MAX_CAPACITY_WH) errs.push('plan.capacityWh muss 1..' + MAX_CAPACITY_WH + ' sein'); else out.capacityWh = capacityWh;
  }
  const targetPct = numOrNull(p.targetPct);
  if (targetPct != null) {
    if (targetPct < 0 || targetPct > 100) errs.push('plan.targetPct muss 0..100 sein'); else out.targetPct = targetPct;
  }
  if (p.deadline != null && String(p.deadline) !== '') {
    if (!HHMM_RE.test(String(p.deadline))) errs.push('plan.deadline muss HH:MM sein'); else out.deadline = String(p.deadline).padStart(5, '0');
  }
  return out;
}

/**
 * Validiert + normalisiert einen planbaren Geräte-Config-Eintrag.
 * @param {object} raw
 * @returns {{ ok: true, device: object } | { ok: false, errors: string[] }}
 */
export function validateSchedulableDevice(raw) {
  const errs = [];
  if (!isObj(raw)) return { ok: false, errors: ['device muss ein Objekt sein'] };

  const id = String(raw.id || '').trim();
  if (!id) errs.push('id erforderlich');
  else if (!ID_RE.test(id)) errs.push('id ungültig (nur A-Z a-z 0-9 _ - , max 64)');

  const name = String(raw.name || '').trim().slice(0, 80);
  if (!name) errs.push('name erforderlich');

  const kind = String(raw.kind || '');
  if (!DEVICE_KINDS.includes(kind)) errs.push('kind muss deferrable|modulating sein');

  const plan = isObj(raw.plan) ? raw.plan : null;
  let normPlan = null;
  if (!plan) errs.push('plan erforderlich');
  else if (kind === 'deferrable') normPlan = validateDeferrablePlan(plan, errs);
  else if (kind === 'modulating') normPlan = validateModulatingPlan(plan, errs);

  const endpoint = validateEndpoint(raw.endpoint, kind, errs);

  if (errs.length) return { ok: false, errors: errs };

  const device = {
    id, name,
    schedulable: true,
    kind,
    enabled: raw.enabled !== false,
    managed: raw.managed === true,
    plan: normPlan,
    endpoint,
  };
  // Optionale Ist-Leistungsmessung (misst den echten Verbrauch → speist EOS-
  // measurement_keys / Verifikation). Reine Passthrough der vorhandenen
  // Adapter-Config; kein Pflichtfeld.
  if (raw.adapter === 'shelly-http' && isObj(raw.shelly)) { device.adapter = 'shelly-http'; device.shelly = raw.shelly; }
  else if (raw.adapter === 'mqtt-generic' && isObj(raw.mqtt)) { device.adapter = 'mqtt-generic'; device.mqtt = raw.mqtt; }

  return { ok: true, device };
}

/**
 * Alle planbaren Geräte aus der Config, normalisiert. Ungültige werden
 * übersprungen (mit Sammel-Fehlern), damit ein kaputter Eintrag nicht den
 * ganzen Service lahmlegt.
 * @param {object} cfg
 * @returns {{ devices: object[], errors: Array<{id:string, errors:string[]}> }}
 */
export function loadSchedulableDevices(cfg) {
  const list = Array.isArray(cfg?.devices) ? cfg.devices : [];
  const devices = [];
  const errors = [];
  for (const raw of list) {
    if (!isSchedulableDevice(raw)) continue;
    const r = validateSchedulableDevice(raw);
    if (r.ok) devices.push(r.device);
    else errors.push({ id: String(raw?.id || '?'), errors: r.errors });
  }
  return { devices, errors };
}
