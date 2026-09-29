// services/input-push.js — HTTP-Push-Eingang für externe Messwerte (Loxone
// Virtueller Ausgang, Home-Assistant-REST, Skripte) in das DVhub-MQTT-Schema.
//
// Die Werte landen im SELBEN Cache wie die MQTT-Eingänge <prefix>/input/…
// (transport.ingest) — Frische-Regeln, Poller, Ableitungen und Steuerung
// arbeiten dadurch unverändert. Aktiv nur mit dem Hersteller-Profil
// „Universal (DVhub-MQTT-Schema: HA/Loxone)“ (victron.mqtt.schema = 'dvhub').
//
// Authentisierung: eigener Push-Schlüssel im Header `X-DVhub-Push-Key` (oder
// ein gültiger Bearer-apiToken). Bewusst KEIN LAN-Freibrief: gefälschte
// Messwerte (SoC, Netz) würden die Batteriesteuerung beeinflussen. Der eigene
// Header erzwingt zudem einen CORS-Preflight — eine fremde Webseite im Browser
// des Kunden kann ihn nicht blind senden (CSRF).
// Schlüssel: 32 Byte zufällig, ${DATA_DIR}/input-push-key (0600).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PUSH_KEY_FILE = 'input-push-key';
export const PUSH_HEADER = 'x-dvhub-push-key';

// Feldname im Push → logischer Eingang des Transports (+ Grenzen).
// Vorzeichen wie im MQTT-Schema: Netz Bezug positiv, Batterie Laden positiv.
export const PUSH_FIELDS = {
  grid_w:      { input: 'grid_total',        min: -1e6, max: 1e6, label: 'Netz gesamt (Bezug +)' },
  grid_l1_w:   { input: 'grid_l1',           min: -1e6, max: 1e6, label: 'Netz L1' },
  grid_l2_w:   { input: 'grid_l2',           min: -1e6, max: 1e6, label: 'Netz L2' },
  grid_l3_w:   { input: 'grid_l3',           min: -1e6, max: 1e6, label: 'Netz L3' },
  pv_w:        { input: 'pv_total',          min: 0,    max: 1e6, label: 'PV gesamt' },
  battery_w:   { input: 'battery_power',     min: -1e6, max: 1e6, label: 'Batterie (Laden +)' },
  soc_pct:     { input: 'battery_soc',       min: 0,    max: 100, label: 'Batterie-SoC' },
  load_w:      { input: 'consumption_total', min: 0,    max: 1e6, label: 'Hausverbrauch' },
  load_l1_w:   { input: 'consumption_l1',    min: 0,    max: 1e6, label: 'Hausverbrauch L1' },
  load_l2_w:   { input: 'consumption_l2',    min: 0,    max: 1e6, label: 'Hausverbrauch L2' },
  load_l3_w:   { input: 'consumption_l3',    min: 0,    max: 1e6, label: 'Hausverbrauch L3' },
};

// Eingabe (Query/JSON) → { values: [{field, input, value}], errors: [...] }.
// Unbekannte Felder → Fehler (Tippfehler sollen auffallen, nicht still verpuffen).
export function parsePushFields(obj) {
  const values = [];
  const errors = [];
  for (const [field, raw] of Object.entries(obj || {})) {
    if (field === 'uiToken') continue;
    const spec = PUSH_FIELDS[field];
    if (!spec) { errors.push(`${field}: unbekanntes Feld`); continue; }
    const str = typeof raw === 'number' ? String(raw) : String(raw ?? '').trim().replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(str)) { errors.push(`${field}: keine Zahl`); continue; }
    const value = Number(str);
    if (value < spec.min || value > spec.max) { errors.push(`${field}: außerhalb ${spec.min}…${spec.max}`); continue; }
    values.push({ field, input: spec.input, value });
  }
  return { values, errors };
}

export function createInputPush(ctx = {}, deps = {}) {
  const fsImpl = deps.fs || fs;
  const dataDir = () => (typeof ctx.getDataDir === 'function' ? ctx.getDataDir() : null) || process.env.DV_DATA_DIR || '.';
  const keyPath = () => path.join(dataDir(), PUSH_KEY_FILE);

  function readKey() {
    try {
      const k = String(fsImpl.readFileSync(keyPath(), 'utf8')).trim();
      return /^[a-f0-9]{64}$/.test(k) ? k : null;
    } catch { return null; }
  }
  function regenerate() {
    const k = crypto.randomBytes(32).toString('hex');
    const tmp = `${keyPath()}.tmp`;
    fsImpl.writeFileSync(tmp, k, { mode: 0o600 });
    fsImpl.renameSync(tmp, keyPath());
    return k;
  }
  function verifyKey(candidate) {
    const k = readKey();
    if (!k || typeof candidate !== 'string') return false;
    const a = Buffer.from(candidate.trim()), b = Buffer.from(k);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return { readKey, regenerate, verifyKey, hasKey: () => !!readKey() };
}
