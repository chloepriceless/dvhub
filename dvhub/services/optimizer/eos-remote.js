// services/optimizer/eos-remote.js — EOS im Fernbetrieb (optimizer.eosProxy.mode = 'remote').
//
// Boxen mit schwacher Hardware lassen ihren EOS-Plan von einem Rechendienst
// rechnen. Damit das Regelverhalten GENAU gleich bleibt, ändert sich an den
// EOS-Modulen nichts: DVhub startet eine EOS-Fassade auf 127.0.0.1, und
// resolveEosProxy() zeigt auf sie. Die Fassade
//
//   - nimmt PUT /v1/config/<pfad>, PUT /v1/prediction/import/<Provider> und
//     PUT /v1/measurement/value an und merkt sich den letzten Stand
//     (Prognosen nach Zeitstempel zusammengeführt, wie EOS es tut);
//   - antwortet auf GET /v1/config wie ein EOS 0.4 (eos-remote-profile.js);
//   - packt bei POST /v1/optimize alles in EINEN Auftrag, schickt ihn an den
//     Dienst, wartet per Long-Poll und gibt EOS' Antwort zurück;
//   - liefert danach Plan und Lösung über GET /v1/energy-management/*.
//
// Rückfall: Ist der Dienst nicht erreichbar, scheitert der Lauf wie bei einem
// lokalen EOS; die Fassade liefert weiter den letzten Plan, DVhub behält ihn
// (keepLastEosPlan) und state.optimizer.eosRemote sagt es der Oberfläche.
// Optional (remote.localFallback) rechnet stattdessen das lokal installierte
// EOS unter optimizer.eosProxy.url.
//
// Der Dienst selbst ist privat; hier steht nur seine einstellbare Adresse.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { EOS_REMOTE_PROFILE, EOS_REMOTE_DEVICE_TEMPLATES } from './eos-remote-profile.js';

// Die Pfade, die der Dienst annimmt — in der Reihenfolge, in der EOS sie
// braucht. Alles andere (ems/interval, ems/mode, measurement/historic_hours,
// database/*) betrifft nur ein dauerhaft laufendes EOS und bleibt hier.
export const REMOTE_FORWARD_PATHS = Object.freeze([
  'devices/max_batteries',
  'devices/max_inverters',
  'devices/batteries',
  'devices/inverters',
  'devices/max_electric_vehicles',
  'devices/electric_vehicles',
  'devices/max_home_appliances',
  'devices/home_appliances',
  'general/timezone_override',
  'optimization/algorithm',
  'optimization/genetic/interval_sec',
  'optimization/genetic/horizon_hours',
  'optimization/genetic/generations',
  'optimization/genetic/individuals',
  'optimization/self_consumption_interpolator',
  'pvforecast/provider',
  'load/provider',
  'elecprice/provider',
  'feedintariff/provider',
  'feedintariff/direct_marketing_enabled',
]);

const PROVIDER_COLUMNS = Object.freeze({
  PVForecastImport: 'pvforecast_ac_power',
  LoadImport: 'loadforecast_power_w',
  ElecPriceImport: 'elecprice_marketprice_wh',
  FeedInTariffImport: 'feed_in_tariff_wh',
});

export const DEFAULT_REMOTE_EOS_VERSION = 'v0.4.0rc3';
export const EOS_REMOTE_FACADE_PORT = 8513;
export const DEFAULT_REMOTE_JOB_TIMEOUT_MS = 20 * 60_000;
export const MAX_REMOTE_JOB_TIMEOUT_MS = 90 * 60_000;
const MAX_ODD_POLLS = 10;
const POLL_WAIT_S = 25;
const PRED_PAST_MS = 6 * 3600_000;
const PRED_FUTURE_MS = 8 * 24 * 3600_000;
const PRED_KEEP_MS = 2 * 24 * 3600_000;
const MAX_ROWS = 2000;
const MAX_BODY = 8 * 1024 * 1024;

/** Fernbetrieb eingeschaltet? */
export function eosRemoteActive(cfg) {
  const p = cfg?.optimizer?.eosProxy || {};
  return p.enabled === true && p.mode === 'remote';
}

export function remoteSettings(cfg) {
  const r = cfg?.optimizer?.eosProxy?.remote || {};
  const t = Number(r.jobTimeoutMs);
  return {
    endpoint: String(r.endpoint || '').trim().replace(/\/+$/, ''),
    token: typeof r.token === 'string' ? r.token.trim() : '',
    // Für welche Adresse das Token ausgegeben wurde. Andere Adresse → neu
    // einschreiben, das alte Token geht nie an einen anderen Dienst.
    tokenEndpoint: String(r.tokenEndpoint || '').trim().replace(/\/+$/, ''),
    // Höchstens die Hälfte der Wartezeit des Lauf-Anstoßes (EOS_RUN_TIMEOUT_MS,
    // 3 h): Fernlauf und ggf. lokaler Rückfall haben je dieses Budget.
    jobTimeoutMs: Number.isFinite(t) && t > 0 ? Math.min(MAX_REMOTE_JOB_TIMEOUT_MS, Math.max(10_000, t)) : DEFAULT_REMOTE_JOB_TIMEOUT_MS,
    localFallback: r.localFallback === true,
    // Opt-in: der Dienst legt je Auftrag ein Diagnosepaket für den Support an.
    debugBundle: r.debugBundle === true,
  };
}

function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  const parts = h.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return parts[0] === 127 || parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

/**
 * Darf DVhub diese Adresse als Rechendienst ansprechen? https zu jedem Host,
 * http nur im eigenen Netz (Test, Runner im LAN). Keine Zugangsdaten in der URL
 * — die Box schickt dorthin ihren Lizenzschlüssel.
 */
export function isAllowedRemoteEndpoint(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && isPrivateHost(u.hostname);
}

/** EOS-Stand, den diese DVhub-Fassung erwartet (eos-version.env, EOS_PIN). */
export function readEosPin(appDir) {
  for (const p of [path.join(appDir || '.', '..', 'eos-version.env'), path.join(appDir || '.', 'eos-version.env')]) {
    try {
      const m = /^EOS_PIN=([^\s#]+)/m.exec(fs.readFileSync(p, 'utf8'));
      if (m) return m[1];
    } catch { /* nächste Stelle */ }
  }
  return DEFAULT_REMOTE_EOS_VERSION;
}

class RemoteError extends Error {
  /** @param {boolean} fallbackOk  darf das lokale EOS einspringen? */
  constructor(code, message, fallbackOk = true) { super(message); this.code = code; this.fallbackOk = fallbackOk; }
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isoZ = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

function parseIntervalMs(s) {
  const m = /^(\d+)\s*(second|minute|hour)s?$/i.exec(String(s || '').trim());
  if (!m) return 15 * 60_000;
  return Number(m[1]) * ({ second: 1000, minute: 60_000, hour: 3600_000 }[m[2].toLowerCase()]);
}

function readReqBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) { resolve(undefined); return; }
      try { resolve(JSON.parse(text)); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

/** Kleiner HTTP-Aufruf an ein lokales EOS (Rückfall). Wirft bei Netzfehlern. */
function localEos(baseUrl, method, pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      hostname: url.hostname, port: url.port || 8503, path: url.pathname + url.search, method, timeout: timeoutMs,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        resolve({ status: res.statusCode, data });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/**
 * @param {object} deps
 * @param {()=>object} deps.getCfg
 * @param {()=>({licenseKey:string, machineFile:string}|null)} deps.getLicenceProof
 * @param {(token:string, endpoint:string)=>Promise<void>} deps.saveToken
 * @param {object} [deps.state]
 * @param {Function} [deps.pushLog]
 * @param {string} [deps.eosVersion]
 * @param {Function} [deps.fetchImpl]
 */
export function createEosRemoteFacade({
  getCfg, getLicenceProof, saveToken, state, pushLog = () => {},
  eosVersion = DEFAULT_REMOTE_EOS_VERSION, fetchImpl = fetch, now = () => Date.now(),
  localRequest = localEos,
}) {
  const startedAt = new Date().toISOString();
  const config = new Map();       // Pfad → Wert (Reihenfolge des ersten Eintreffens)
  const predictions = new Map();  // Provider → { column, tz, rows: Map<ms, Wert> }
  const measurements = new Map(); // Schlüssel → { datetime, value }
  let last = null;                // { optimize, plan, solution, at, source }
  let chain = Promise.resolve();
  let server = null;
  let baseUrl = null;

  const log = (event, data) => { try { pushLog(event, data); } catch { /* Log darf nie stören */ } };

  function setStatus(patch) {
    if (!state) return;
    state.optimizer = state.optimizer || {};
    const prev = state.optimizer.eosRemote || {
      mode: 'remote', endpointHost: null, enrolled: false, phase: 'idle', lastJobId: null, lastSubmitAt: null,
      lastOkAt: null, lastRunMs: null, lastError: null, usingLastPlan: false, fallback: null, queuePosition: null,
      eosVersion, diagnostics: null,
    };
    state.optimizer.eosRemote = { ...prev, ...patch };
  }
  {
    const rs = remoteSettings(getCfg());
    let host;
    try { host = rs.endpoint ? new URL(rs.endpoint).host : null; } catch { host = null; }
    setStatus({ endpointHost: host, enrolled: !!rs.token });
  }

  // ------------------------------------------------------------ Konfiguration

  function deviceSectionOf(p) {
    const m = /^devices\/(batteries|inverters|electric_vehicles|home_appliances)$/.exec(p);
    return m ? m[1] : null;
  }

  function buildConfig() {
    const out = clone(EOS_REMOTE_PROFILE);
    for (const [p, v] of config) {
      const parts = p.split('/');
      let node = out;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (!isObj(node[parts[i]])) node[parts[i]] = {};
        node = node[parts[i]];
      }
      const section = deviceSectionOf(p);
      if (section && isObj(v)) {
        const tpl = EOS_REMOTE_DEVICE_TEMPLATES[section];
        node[parts[parts.length - 1]] = Object.fromEntries(Object.entries(v).map(([id, dev]) => [id, { ...tpl, ...(isObj(dev) ? dev : {}) }]));
      } else {
        node[parts[parts.length - 1]] = clone(v);
      }
    }
    return out;
  }

  function devicesOf(section) {
    const v = config.get(`devices/${section}`);
    return isObj(v) ? Object.keys(v) : [];
  }

  function measurementKeys() {
    const keys = ['date_time'];
    for (const id of [...devicesOf('batteries'), ...devicesOf('electric_vehicles')]) keys.push(`${id}-soc-factor`);
    for (const id of devicesOf('home_appliances')) keys.push(`${id}.cycles_completed`);
    return keys;
  }

  // -------------------------------------------------------------- Prognosen

  function mergePrediction(provider, body) {
    const column = PROVIDER_COLUMNS[provider];
    const entry = predictions.get(provider) || { column, tz: 'Europe/Berlin', rows: new Map() };
    if (isObj(body?.data)) {
      for (const [ts, row] of Object.entries(body.data)) {
        const ms = Date.parse(ts);
        const v = row?.[column];
        if (Number.isFinite(ms) && typeof v === 'number' && Number.isFinite(v)) entry.rows.set(ms, v);
      }
      if (typeof body.tz === 'string' && body.tz) entry.tz = body.tz;
    } else if (body?.start_datetime && Array.isArray(body[column])) {
      const start = Date.parse(body.start_datetime);
      const step = parseIntervalMs(body.interval);
      if (Number.isFinite(start)) {
        body[column].forEach((v, i) => { if (typeof v === 'number' && Number.isFinite(v)) entry.rows.set(start + i * step, v); });
      }
    }
    const cutoff = now() - PRED_KEEP_MS;
    for (const ms of entry.rows.keys()) if (ms < cutoff) entry.rows.delete(ms);
    predictions.set(provider, entry);
  }

  function predictionsForJob() {
    const t = now();
    const out = {};
    for (const [provider, e] of predictions) {
      const rows = [...e.rows.entries()]
        .filter(([ms]) => ms >= t - PRED_PAST_MS && ms <= t + PRED_FUTURE_MS)
        .sort((a, b) => a[0] - b[0])
        .slice(0, MAX_ROWS);
      if (!rows.length) continue;
      out[provider] = {
        data: Object.fromEntries(rows.map(([ms, v]) => [isoZ(ms), { [e.column]: v }])),
        dtypes: { [e.column]: 'float64' },
        tz: e.tz,
        datetime_columns: [],
      };
    }
    return out;
  }

  function measurementsForJob() {
    const appliances = new Set(devicesOf('home_appliances'));
    const out = [];
    for (const [key, m] of measurements) {
      const id = key.slice(0, -'.cycles_completed'.length);
      if (!appliances.has(id)) continue;
      out.push({ key, datetime: m.datetime, value: m.value });
    }
    return out;
  }

  // ------------------------------------------------------------- Dienst

  async function call(rs, method, p, { token, body, timeoutMs = 30_000 } = {}) {
    const headers = { Accept: 'application/json' };
    let payload;
    if (body !== undefined) {
      payload = zlib.gzipSync(Buffer.from(JSON.stringify(body)));
      headers['Content-Type'] = 'application/json';
      headers['Content-Encoding'] = 'gzip';
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetchImpl(rs.endpoint + p, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      throw new RemoteError(timeout ? 'service_timeout' : 'service_unreachable', timeout ? 'Rechendienst antwortet nicht' : 'Rechendienst nicht erreichbar');
    }
    let json;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json, retryAfter: res.headers.get('retry-after') };
  }

  async function enroll(rs, proof) {
    setStatus({ phase: 'enrolling' });
    const r = await call(rs, 'POST', '/v1/enroll', { body: { licenseKey: proof.licenseKey, machineFile: proof.machineFile, label: 'DVhub' } });
    if (r.status !== 200 || typeof r.json?.token !== 'string') {
      const code = r.json?.error?.code || `http_${r.status}`;
      throw new RemoteError(r.status >= 500 ? 'service_error' : 'enroll_rejected', `Einschreiben abgelehnt (${code})`, true);
    }
    await saveToken(r.json.token, rs.endpoint);
    setStatus({ enrolled: true });
    log('eos_remote_enrolled', { boxId: r.json.boxId || null });
    return r.json.token;
  }

  function submitError(r) {
    const code = r.json?.error?.code || `http_${r.status}`;
    if (r.status === 429) return new RemoteError('quota_exceeded', `Kontingent erschöpft (${code}), wieder in ${r.retryAfter || '?'} s`);
    if (r.status === 403) return new RemoteError('licence_rejected', `Lizenz abgelehnt (${code})`);
    if (r.status === 422) return new RemoteError('invalid_payload', `Auftrag abgelehnt: ${String(r.json?.error?.message || code).slice(0, 200)}`);
    if (r.status >= 500) return new RemoteError('service_error', `Rechendienst-Fehler (${code})`);
    return new RemoteError('service_error', `Unerwartete Antwort (${code})`);
  }

  async function runRemote(body, cfg, rs, deadlineAt) {
    if (!rs.endpoint) throw new RemoteError('no_endpoint', 'Keine Adresse des Rechendienstes eingestellt');
    const proof = getLicenceProof?.() || null;
    if (!proof?.licenseKey || !proof?.machineFile) throw new RemoteError('licence_missing', 'Keine aktive Pro-Lizenz mit Machine-File auf dieser Box');
    const job = {
      clientJobId: crypto.randomUUID(),
      eosVersion,
      deadline: new Date(deadlineAt).toISOString(),
      licence: { key: proof.licenseKey, machineFile: proof.machineFile },
      config: Object.fromEntries(REMOTE_FORWARD_PATHS.filter((p) => config.has(p)).map((p) => [p, config.get(p)])),
      predictions: predictionsForJob(),
      measurements: measurementsForJob(),
      optimize: isObj(body) ? body : {},
      ...(rs.debugBundle ? { debug: true } : {}),
    };
    const tokenFits = rs.token && (!rs.tokenEndpoint || rs.tokenEndpoint === rs.endpoint);
    let token = tokenFits ? rs.token : await enroll(rs, proof);
    setStatus({ phase: 'submitting' });
    let r = await call(rs, 'POST', '/v1/jobs', { token, body: job });
    if (r.status === 401) {
      token = await enroll(rs, proof);
      r = await call(rs, 'POST', '/v1/jobs', { token, body: job });
    }
    if (r.status !== 202 || typeof r.json?.id !== 'string') throw submitError(r);
    const id = r.json.id;
    setStatus({ phase: 'queued', lastJobId: id, lastSubmitAt: new Date(now()).toISOString(), queuePosition: null });
    log('eos_remote_submitted', { jobId: id, superseded: (r.json.superseded || []).length });

    let oddPolls = 0;
    for (;;) {
      const left = deadlineAt - now();
      if (left <= 0) throw new RemoteError('service_timeout', 'Kein Ergebnis innerhalb der Frist');
      const wait = Math.max(0, Math.min(POLL_WAIT_S, Math.floor(left / 1000)));
      let p;
      try {
        p = await call(rs, 'GET', `/v1/jobs/${encodeURIComponent(id)}?wait=${wait}`, { token, timeoutMs: (wait + 15) * 1000 });
      } catch (e) {
        // Kurz weg: bis zur Frist weiter fragen.
        if (deadlineAt - now() <= 5000) throw e;
        await new Promise((res) => { const tm = setTimeout(res, 5000); tm.unref?.(); });
        continue;
      }
      if (p.status !== 200) throw submitError(p);
      const s = p.json?.status;
      if (!['queued', 'running', 'done', 'failed', 'expired', 'superseded'].includes(s)) {
        // Unbekannte Antwort (Proxy-Seite, neuer Status): nicht im Dauerfeuer
        // weiterfragen, nach wenigen Versuchen aufgeben.
        oddPolls += 1;
        if (oddPolls >= MAX_ODD_POLLS) throw new RemoteError('service_error', 'Unerwartete Antworten des Rechendienstes');
        await new Promise((res) => { const tm = setTimeout(res, 2000); tm.unref?.(); });
        continue;
      }
      setStatus({ phase: s === 'running' ? 'running' : (s === 'queued' ? 'queued' : 'receiving'), queuePosition: p.json?.queuePosition ?? null });
      if (s === 'done') {
        const res = p.json.result;
        if (!res?.optimize || !res?.plan || !res?.solution) throw new RemoteError(p.json?.error?.code || 'result_missing', 'Ergebnis fehlt');
        return {
          optimize: res.optimize, plan: res.plan, solution: res.solution, runMs: res.runMs ?? null, jobId: id,
          diagnostics: isObj(res.diagnostics) ? res.diagnostics : null,
        };
      }
      if (s === 'failed' || s === 'expired' || s === 'superseded') {
        const code = p.json?.error?.code || s;
        // Was EOS selbst ablehnt, lehnt ein lokales EOS genauso ab.
        const sameLocally = /^(no_solution|eos_rejected_|invalid_payload)/.test(code);
        throw new RemoteError(code, String(p.json?.error?.message || s).slice(0, 300), !sameLocally);
      }
    }
  }

  // Der Rückfall hat ein EIGENES Budget (jobTimeoutMs): Scheitert der Fernlauf
  // erst an der Frist, bliebe sonst nichts für das lokale EOS. Zweimal die
  // höchste Wartezeit (90 min) passt in die 3 h des Lauf-Anstoßes.
  async function runLocal(body, cfg, rs) {
    const base = cfg?.optimizer?.eosProxy?.url || 'http://127.0.0.1:8503';
    const t = 15_000;
    const ordered = [
      ...REMOTE_FORWARD_PATHS.filter((p) => config.has(p)),
      ...[...config.keys()].filter((p) => !REMOTE_FORWARD_PATHS.includes(p)),
    ];
    const must = async (method, p, b, timeoutMs = t) => {
      const r = await localRequest(base, method, p, b, timeoutMs);
      if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${p.split('?')[0]}: HTTP ${r.status}`);
      return r.data;
    };
    for (const p of ordered) await must('PUT', `/v1/config/${p}`, config.get(p));
    for (const [prov, df] of Object.entries(predictionsForJob())) await must('PUT', `/v1/prediction/import/${prov}?force_enable=true`, df);
    for (const m of measurementsForJob()) {
      await must('PUT', `/v1/measurement/value?datetime=${encodeURIComponent(m.datetime)}&key=${encodeURIComponent(m.key)}&value=${m.value}`);
    }
    const optimize = await must('POST', '/v1/optimize', isObj(body) ? body : {}, rs.jobTimeoutMs);
    const plan = await must('GET', '/v1/energy-management/plan');
    const solution = await must('GET', '/v1/energy-management/optimization/solution');
    return { optimize, plan, solution, runMs: null, jobId: null, diagnostics: null };
  }

  async function runOptimize(body) {
    const cfg = getCfg();
    const rs = remoteSettings(cfg);
    const t0 = now();
    const deadlineAt = t0 + rs.jobTimeoutMs;
    let result = null;
    let fallback = null;
    let error = null;
    try {
      result = await runRemote(body, cfg, rs, deadlineAt);
    } catch (e) {
      error = e instanceof RemoteError ? e : new RemoteError('client_error', String(e?.message || e));
    }
    if (!result && error.fallbackOk && rs.localFallback) {
      try {
        result = await runLocal(body, cfg, rs);
        fallback = 'local';
        log('eos_remote_local_fallback', { reason: error.code });
      } catch (e) {
        error = new RemoteError(error.code, `${error.message}; lokales EOS: ${String(e?.message || e).slice(0, 120)}`, false);
      }
    }
    if (result) {
      last = { ...result, at: now(), source: fallback || 'remote' };
      setStatus({
        phase: 'idle', lastOkAt: new Date(now()).toISOString(), lastRunMs: result.runMs ?? (now() - t0),
        lastError: fallback ? { code: error.code, message: error.message, at: new Date(now()).toISOString() } : null,
        usingLastPlan: false, fallback, queuePosition: null, diagnostics: result.diagnostics,
      });
      return { status: 200, body: result.optimize };
    }
    setStatus({
      phase: 'idle', queuePosition: null, fallback: null,
      lastError: { code: error.code, message: error.message, at: new Date(now()).toISOString() },
      usingLastPlan: !!last,
    });
    log('eos_remote_failed', { code: error.code, message: error.message, usingLastPlan: !!last });
    return { status: 503, body: { title: 'Fernrechnung fehlgeschlagen', detail: `${error.code}: ${error.message}` } };
  }

  // ------------------------------------------------------------- HTTP

  function send(res, status, obj) {
    const body = obj === undefined ? '' : JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const p = url.pathname;
      const body = req.method === 'PUT' || req.method === 'POST' ? await readReqBody(req) : undefined;

      if (req.method === 'GET' && p === '/v1/health') {
        return send(res, 200, { status: 'alive', pid: process.pid, started_at: startedAt, version: eosVersion, remote: true });
      }
      if (req.method === 'GET' && p === '/v1/config') return send(res, 200, buildConfig());
      if (p.startsWith('/v1/config/')) {
        const key = p.slice('/v1/config/'.length);
        if (req.method === 'PUT' && key === 'file') return send(res, 200, {});
        if (req.method === 'PUT') { config.set(key, clone(body === undefined ? null : body)); return send(res, 200, {}); }
        if (req.method === 'GET') {
          let node = buildConfig();
          for (const part of key.split('/')) node = isObj(node) ? node[part] : undefined;
          return node === undefined ? send(res, 404, { detail: 'unknown key' }) : send(res, 200, node);
        }
      }
      if (req.method === 'GET' && p === '/v1/measurement/keys') return send(res, 200, measurementKeys());
      if (req.method === 'PUT' && p === '/v1/measurement/value') {
        const key = url.searchParams.get('key') || '';
        const value = Number(url.searchParams.get('value'));
        if (/\.cycles_completed$/.test(key) && Number.isFinite(value)) {
          measurements.set(key, { datetime: url.searchParams.get('datetime') || new Date(now()).toISOString(), value: Math.trunc(value) });
        }
        return send(res, 200);
      }
      if (req.method === 'PUT' && p.startsWith('/v1/prediction/import/')) {
        const provider = decodeURIComponent(p.slice('/v1/prediction/import/'.length));
        if (!PROVIDER_COLUMNS[provider]) return send(res, 404, { detail: `Provider '${provider}' not found.` });
        mergePrediction(provider, body);
        return send(res, 200);
      }
      if (req.method === 'GET' && p === '/v1/prediction/series') {
        const key = url.searchParams.get('key');
        const entry = [...predictions.values()].find((e) => e.column === key);
        if (!entry) return send(res, 404, { detail: 'unknown key' });
        return send(res, 200, { data: Object.fromEntries([...entry.rows.entries()].sort((a, b) => a[0] - b[0]).map(([ms, v]) => [isoZ(ms), v])) });
      }
      if (req.method === 'POST' && p === '/v1/optimize') {
        const run = chain.then(() => runOptimize(body));
        chain = run.catch(() => {});
        const r = await run;
        return send(res, r.status, r.body);
      }
      if (req.method === 'GET' && p === '/v1/energy-management/plan') return last ? send(res, 200, last.plan) : send(res, 404, { detail: 'no plan' });
      if (req.method === 'GET' && p === '/v1/energy-management/optimization/solution') return last ? send(res, 200, last.solution) : send(res, 404, { detail: 'no solution' });
      return send(res, 404, { detail: 'not available in remote mode' });
    } catch (e) {
      return send(res, 400, { detail: String(e?.message || e).slice(0, 200) });
    }
  }

  return {
    /** Fassade auf 127.0.0.1 starten; liefert ihre Adresse. */
    async start({ port = 0 } = {}) {
      if (server) return baseUrl;
      const srv = http.createServer((req, res) => { handle(req, res); });
      srv.requestTimeout = 0; // POST /v1/optimize wartet bis zum Ergebnis
      // Belegter Port: Fehler weitergeben, Fassade bleibt startbar.
      await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, '127.0.0.1', () => { srv.off('error', reject); resolve(); });
      });
      server = srv;
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      return baseUrl;
    },
    async stop() {
      if (!server) return;
      const s = server;
      server = null;
      baseUrl = null;
      s.closeAllConnections?.();
      await new Promise((r) => s.close(r));
    },
    url: () => baseUrl,
    /**
     * Diagnosepaket des letzten Auftrags vom Dienst holen (nur wenn
     * remote.debugBundle an war; der Dienst löscht es nach seiner Frist).
     * @returns {Promise<null|{jobId:string, bundle:object}>}
     */
    async fetchDebugBundle() {
      const jobId = state?.optimizer?.eosRemote?.lastJobId;
      const rs = remoteSettings(getCfg());
      if (!jobId || !rs.endpoint || !rs.token) return null;
      const r = await call(rs, 'GET', `/v1/jobs/${encodeURIComponent(jobId)}/debug`, { token: rs.token });
      if (r.status !== 200 || !isObj(r.json?.bundle)) return null;
      return { jobId, bundle: r.json.bundle };
    },
    /** Für Tests und Diagnose: was die Fassade gerade hält (ohne Lizenz/Token). */
    snapshot: () => ({ configPaths: [...config.keys()], providers: [...predictions.keys()], hasPlan: !!last }),
  };
}
