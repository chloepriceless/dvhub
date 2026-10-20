// services/vehicle-evcc/index.js — Ladestand des E-Autos über evccs Fahrzeug-Treiber.
//
// Christin 2026-10-20: DVhub kannte den Ladestand bisher nur von TeslaMate, der
// Wallbox (evcc-Ladepunkt, OpenEVSE …) oder einem MQTT-Topic. evcc bringt für
// rund 45 Marken Treiber mit, die den Ladestand beim Hersteller abfragen — MIT-
// lizenziert, die meisten ohne evcc-Sponsor-Lizenz. Viele Kunden haben kein evcc.
//
// Deshalb: DVhub liefert evcc NICHT im Image aus (Größe). Schaltet jemand die
// Funktion ein, lädt DVhub das evcc-Programm einmalig (feste Version, Prüfsumme
// aus diesem Quelltext) in sein Datenverzeichnis und fragt damit NUR das Auto ab:
//   evcc vehicle dvhub --config <evcc.yaml> --database <evcc.db>
// Die Datenbank hält evccs Anmelde-Tokens zwischen den Abfragen. Gesteuert wird
// über diesen Weg nichts.
//
// Welche Marken und Felder es gibt, steht in catalog.json (erzeugt mit
// scripts/gen-evcc-vehicle-catalog.mjs aus evccs eigener Vorlagen-API).
//
// Einstellungen (vehicleEvcc.*): enabled, template, params {feld: wert},
// intervalMin (Abfrage, solange das Auto steckt; sonst höchstens stündlich).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export const EVCC_VERSION = '0.317.2';
// checksums.txt des evcc-Releases 0.317.2 (github.com/evcc-io/evcc/releases).
const EVCC_ASSETS = Object.freeze({
  arm64: { name: 'linux-arm64', sha256: 'f683d209429712517630099081b39c9aa103013ab80f0b474f155d919f3d64a8' },
  x64: { name: 'linux-amd64', sha256: '79dbcf0c8221a61f0aa033d355f99f6582ab3148b2314bdcaadc4c2f5b4b43d2' },
  arm: { name: 'linux-armv6', sha256: 'eeb500923192b6034ac7c5de060ab661e4232ecf185bb9658dced8b4590ed908' },
});
export const VEHICLE_NAME = 'dvhub';
export const DEFAULT_INTERVAL_MIN = 15;
const UNPLUGGED_INTERVAL_MIN = 60;
const RUN_TIMEOUT_MS = 150_000;
const TICK_MS = 60_000;
const OUTPUT_LIMIT = 256 * 1024;

export function evccAsset(platform = process.platform, arch = process.arch) {
  const a = platform === 'linux' ? EVCC_ASSETS[arch] : null;
  if (!a) return null;
  const file = `evcc_${EVCC_VERSION}_${a.name}.tar.gz`;
  return { file, sha256: a.sha256, url: `https://github.com/evcc-io/evcc/releases/download/${EVCC_VERSION}/${file}` };
}

let catalogCache = null;
export function loadCatalog() {
  if (!catalogCache) {
    catalogCache = JSON.parse(fs.readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));
  }
  return catalogCache;
}

function templateOf(catalog, name) {
  return (catalog?.templates || []).find((t) => t.template === name) || null;
}

const str = (v) => (v == null ? '' : String(v));

/** @returns {{ ok: boolean, errors: string[] }} */
export function validateVehicleSettings(v, catalog = loadCatalog()) {
  const errors = [];
  const t = templateOf(catalog, v?.template);
  if (!t) return { ok: false, errors: [`Vorlage „${str(v?.template)}“ ist nicht verfügbar`] };
  const params = v?.params && typeof v.params === 'object' ? v.params : {};
  for (const p of t.params) {
    if (p.required && str(params[p.name]).trim() === '') errors.push(`${p.label} (${p.name}) fehlt`);
  }
  return { ok: errors.length === 0, errors };
}

/** evcc.yaml für genau ein Fahrzeug; Werte als JSON-Strings (gültiges YAML, keine Einschleusung). */
export function buildEvccYaml(v, catalog = loadCatalog()) {
  const t = templateOf(catalog, v?.template);
  if (!t) throw new Error('unknown template');
  const params = v?.params && typeof v.params === 'object' ? v.params : {};
  const lines = ['vehicles:', `  - name: ${VEHICLE_NAME}`, '    type: template', `    template: ${JSON.stringify(t.template)}`];
  for (const p of t.params) {
    const raw = params[p.name];
    if (raw == null || str(raw).trim() === '') continue;
    let val;
    if ((p.type === 'int' || p.type === 'float' || p.type === 'number') && Number.isFinite(Number(raw))) val = String(Number(raw));
    else if (p.type === 'bool') val = (raw === true || raw === 'true') ? 'true' : 'false';
    else val = JSON.stringify(str(raw));
    lines.push(`    ${p.name}: ${val}`);
  }
  return lines.join('\n') + '\n';
}

const FIELDS = [
  ['Soc', 'socPct', /^(-?[\d.]+)%$/],
  ['Limit Soc', 'limitSocPct', /^(-?[\d.]+)%$/],
  ['Capacity', 'capacityKwh', /^([\d.]+)kWh$/],
  ['Charge status', 'status', /^([A-F])$/],
  ['Range', 'rangeKm', /^([\d.]+)km$/],
  ['Odometer', 'odometerKm', /^([\d.]+)km$/],
];

/** Ausgabe von `evcc vehicle` (tabwriter: „Label:␣␣Wert␣␣Dauer“). */
export function parseVehicleOutput(text) {
  const values = {};
  const errors = {};
  for (const rawLine of String(text || '').split('\n')) {
    // evcc setzt Fortschrittspunkte vor die erste Zeile („.Soc: …“).
    const line = rawLine.replace(/^[.\s]+/, '');
    const m = line.match(/^([A-Za-z][A-Za-z ]*?):\s+(.*?)\s*$/);
    if (!m) continue;
    const f = FIELDS.find(([label]) => label === m[1]);
    if (!f) continue;
    // Wert ist die erste Spalte; dahinter kann die Messdauer stehen („1.2s“).
    const raw = m[2].replace(/\s{2,}\S+$/, '').trim();
    const hit = raw.match(f[2]);
    if (hit) values[f[1]] = f[1] === 'status' ? hit[1] : Number(hit[1]);
    else errors[f[1]] = raw.slice(0, 300);
  }
  return { values, errors };
}

/**
 * evccs Fehlermeldungen enthalten oft die Abfrage-URL samt Zugangsdaten
 * (z. B. „…/api/cookie?username=x&password=y“). Vor Anzeige und Protokoll
 * schwärzen: alle Werte der Vorlage, die geheim sind, plus typische
 * Query-Parameter.
 */
export function scrubEvccError(text, v) {
  let out = String(text || '');
  const params = v?.params && typeof v.params === 'object' ? v.params : {};
  const t = templateOf(loadCatalog(), v?.template);
  // Nur Geheimnisse und persönliche Angaben — Serveradressen bleiben lesbar.
  const sensitive = (name) => ['user', 'email', 'vin', 'pin'].includes(name) || Boolean(t?.params.find((p) => p.name === name)?.secret);
  for (const [name, val] of Object.entries(params)) {
    const s = str(val);
    if (s.length >= 3 && sensitive(name)) out = out.split(s).join('***');
  }
  out = out.replace(/([?&;](?:password|passwd|pwd|pin|token|access_token|refresh_token|secret|client_secret|code|key|apikey)=)[^&\s"']+/gi, '$1***');
  return out.slice(0, 300);
}

export async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

/** Für die Oberfläche: Geheimnisse leer, nur „gesetzt“ melden. */
export function maskVehicleSettings(v, catalog = loadCatalog()) {
  const t = templateOf(catalog, v?.template);
  const params = { ...(v?.params || {}) };
  const secretsSet = {};
  for (const p of t?.params || []) {
    if (p.secret) { secretsSet[p.name] = str(params[p.name]) !== ''; params[p.name] = ''; }
  }
  return {
    enabled: v?.enabled === true,
    template: str(v?.template),
    params,
    secretsSet,
    intervalMin: Number(v?.intervalMin) || DEFAULT_INTERVAL_MIN,
  };
}

/** Eingabe der Oberfläche übernehmen: Geheimnis leer/„***“ = unverändert (bei gleicher Vorlage). */
export function mergeVehicleSettings(stored, input, catalog = loadCatalog()) {
  const t = templateOf(catalog, input?.template);
  const sameTemplate = stored?.template === input?.template;
  const params = {};
  for (const p of t?.params || []) {
    const val = input?.params?.[p.name];
    if (p.secret && (val == null || val === '' || val === '***')) {
      if (sameTemplate && stored?.params?.[p.name] != null) params[p.name] = stored.params[p.name];
      continue;
    }
    if (val != null && str(val).trim() !== '') params[p.name] = str(val).trim().slice(0, 4096);
  }
  const interval = Number(input?.intervalMin);
  return {
    enabled: input?.enabled === undefined ? stored?.enabled === true : input.enabled === true,
    template: t ? t.template : '',
    params,
    intervalMin: Number.isFinite(interval) ? Math.min(240, Math.max(5, Math.round(interval))) : (Number(stored?.intervalMin) || DEFAULT_INTERVAL_MIN),
  };
}

/**
 * @param {object} ctx  getCfg, pushLog
 * @param {object} deps dataDir, binaryPath (Test), getPlugged, fetch, spawn, execFile, now
 */
export function createVehicleEvcc(ctx, deps = {}) {
  const now = deps.now || (() => Date.now());
  const spawn = deps.spawn || nodeSpawn;
  const execFile = deps.execFile || nodeExecFile;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const evccDir = path.join(deps.dataDir || '/var/lib/dvhub', 'evcc');
  const st = {
    socPct: null, rangeKm: null, odometerKm: null, capacityKwh: null, limitSocPct: null, status: null,
    at: null, lastAttemptAt: null, error: null, running: false, install: { state: 'none', error: null },
  };
  let timer = null;
  let lastAttemptMs = 0;
  let installing = null;

  const settings = () => ctx.getCfg?.()?.vehicleEvcc || {};
  const binPath = () => deps.binaryPath || path.join(evccDir, `evcc-${EVCC_VERSION}`);

  async function install() {
    if (deps.binaryPath || fs.existsSync(binPath())) { st.install = { state: 'ready', error: null }; return true; }
    if (installing) return installing;
    installing = (async () => {
      const asset = evccAsset();
      if (!asset) throw new Error(`kein evcc-Programm für ${process.platform}/${process.arch}`);
      fs.mkdirSync(evccDir, { recursive: true, mode: 0o700 });
      st.install = { state: 'downloading', error: null };
      const tgz = path.join(evccDir, asset.file);
      const res = await fetchImpl(asset.url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`Download HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tgz));
      const sum = await sha256File(tgz);
      if (sum !== asset.sha256) { fs.rmSync(tgz, { force: true }); throw new Error('Prüfsumme des evcc-Programms stimmt nicht'); }
      const tmp = fs.mkdtempSync(path.join(evccDir, 'x-'));
      try {
        await new Promise((resolve, reject) => execFile('tar', ['-xzf', tgz, '-C', tmp, 'evcc'], (e) => (e ? reject(e) : resolve())));
        fs.chmodSync(path.join(tmp, 'evcc'), 0o755);
        fs.renameSync(path.join(tmp, 'evcc'), binPath());
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(tgz, { force: true });
      }
      // Alte Versionen entfernen (nur eigene Dateien im eigenen Verzeichnis).
      for (const f of fs.readdirSync(evccDir)) {
        if (/^evcc-\d/.test(f) && f !== path.basename(binPath())) fs.rmSync(path.join(evccDir, f), { force: true });
      }
      st.install = { state: 'ready', error: null };
      ctx.pushLog?.('vehicle_evcc_installed', { version: EVCC_VERSION });
      return true;
    })().catch((e) => {
      st.install = { state: 'error', error: e?.message || String(e) };
      throw e;
    }).finally(() => { installing = null; });
    return installing;
  }

  function run(args) {
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      const child = spawn(binPath(), args, { env: { ...process.env, HOME: evccDir }, stdio: ['ignore', 'pipe', 'pipe'] });
      const kill = setTimeout(() => { child.kill('SIGKILL'); }, RUN_TIMEOUT_MS);
      child.stdout.on('data', (d) => { if (out.length < OUTPUT_LIMIT) out += d; });
      child.stderr.on('data', (d) => { if (err.length < OUTPUT_LIMIT) err += d; });
      child.on('error', (e) => { clearTimeout(kill); resolve({ code: -1, out, err: err + String(e?.message || e) }); });
      child.on('close', (code) => { clearTimeout(kill); resolve({ code, out, err }); });
    });
  }

  function lastErrorLine(text) {
    const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const bad = lines.filter((l) => /\b(ERROR|FATAL|fatal|error)\b/.test(l));
    return (bad.at(-1) || lines.at(-1) || 'unbekannter Fehler').slice(0, 300);
  }

  async function refresh(reason = 'manual') {
    const v = settings();
    if (v.enabled !== true) return { skipped: 'disabled' };
    const valid = validateVehicleSettings(v);
    if (!valid.ok) { st.error = valid.errors.join('; '); return { ok: false, error: st.error }; }
    if (st.running) return { skipped: 'busy' };
    st.running = true;
    lastAttemptMs = now();
    st.lastAttemptAt = new Date(lastAttemptMs).toISOString();
    try {
      await install();
      fs.mkdirSync(evccDir, { recursive: true, mode: 0o700 });
      const yamlFile = path.join(evccDir, 'evcc.yaml');
      fs.writeFileSync(yamlFile, buildEvccYaml(v), { mode: 0o600 });
      fs.chmodSync(yamlFile, 0o600);
      const res = await run(['vehicle', VEHICLE_NAME, '--config', yamlFile, '--database', path.join(evccDir, 'evcc.db'), '--timeout', '60s']);
      const parsed = parseVehicleOutput(res.out);
      if (Number.isFinite(parsed.values.socPct)) {
        Object.assign(st, {
          socPct: parsed.values.socPct,
          rangeKm: parsed.values.rangeKm ?? null,
          odometerKm: parsed.values.odometerKm ?? null,
          capacityKwh: parsed.values.capacityKwh ?? null,
          limitSocPct: parsed.values.limitSocPct ?? null,
          status: parsed.values.status ?? null,
          at: new Date(now()).toISOString(),
          error: null,
        });
        return { ok: true, socPct: st.socPct, reason };
      }
      st.error = scrubEvccError(parsed.errors.socPct || (res.code !== 0 ? lastErrorLine(res.err || res.out) : 'evcc lieferte keinen Ladestand'), v);
      ctx.pushLog?.('vehicle_evcc_error', { template: v.template, error: st.error, reason }, 'warn');
      return { ok: false, error: st.error };
    } catch (e) {
      st.error = scrubEvccError(e?.message || String(e), v);
      ctx.pushLog?.('vehicle_evcc_error', { template: v.template, error: st.error, reason }, 'warn');
      return { ok: false, error: st.error };
    } finally {
      st.running = false;
    }
  }

  function tick() {
    const v = settings();
    if (v.enabled !== true) return;
    const plugged = deps.getPlugged?.();
    const base = Number(v.intervalMin) || DEFAULT_INTERVAL_MIN;
    const intervalMin = plugged === false ? Math.max(base, UNPLUGGED_INTERVAL_MIN) : base;
    if (now() - lastAttemptMs >= intervalMin * 60_000) refresh('interval').catch(() => {});
  }

  function getState() {
    return { ...st, install: { ...st.install } };
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
    setTimeout(tick, 20_000).unref?.();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { refresh, install, getState, start, stop, tick };
}
