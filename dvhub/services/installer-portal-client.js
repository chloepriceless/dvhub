// services/installer-portal-client.js — ausgehender Kopplungspfad zur
// Installateurs-Portal-Instanz (T-INSTALLER-PORTAL, NAT-Modell).
//
// Warum ausgehend? Kunden sitzen hinter Router/Firewall — das Online-Portal
// kann die Anlage nicht anwählen. Also dreht die Anlage den Spieß um:
//
//   1. Portal: Installateur trägt die Appliance-ID ein → Portal erzeugt
//      Kopplungs-Code (der "Token, den man online bekommt").
//   2. Anlage (Kunden-UI): Portal-URL + Code eintragen → POST /api/installer/
//      client/pair → DIESER Service wählt sich AUSGEHEND zum Portal
//      (POST /api/pair/claim) und erhält ein langlebiges Appliance-Token.
//   3. Portal: Installateur gibt die Anfrage manuell frei.
//   4. Betrieb: Die Anlage pollt alle 30 s das Portal (x-appliance-token) und
//      liefert ihren Kompakt-Status mit; das Portal antwortet mit Kommandos
//      (Tunnel öffnen/schließen, Update-Check), die die Anlage gegen ihre
//      eigenen Loopback-Endpunkte ausführt und deren Ergebnis zurückliefert.
//
// Firewall-Freundlich: nur ausgehendes HTTPS (bzw. http:// zu Testzwecken ins
// lokale Netz). Kein Portforwarding, kein DNS, kein öffentlicher Endpunkt.
//
// Persistenz: ${DATA_DIR}/installer-portal-client.json (Sidecar, analog dem
// Support-Tunnel-Sidecar — config.json wird bei jedem UI-Save überschrieben,
// das Portal-Token muss einen Neustart überleben).

import fs from 'node:fs';
import { AUDIT_ERROR_SQL } from './log-retention.js';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { readApplianceId } from './support-tunnel.js';
import { buildVictronAlarmsPayload } from '../victron-alarms.js';

export const SIDECAR_NAME = 'installer-portal-client.json';
export const POLL_INTERVAL_MS_DEFAULT = 30_000;
export const PAIRING_CODE_RE = /^\d{6}$/;
export const COMMAND_TYPES = ['open_tunnel', 'close_tunnel', 'updates_check', 'license_activate'];

// URL-Validierung für die Portal-Adresse (SSRF-Bremse beim Pairing):
//   https:// ist überall erlaubt (Portal ist online),
//   http://  nur zu Loopback/RFC1918 — für lokale Tests & LAN-Portal-Bau.
export function isAllowedPortalUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol === 'https:') return true;
    if (u.protocol !== 'http:') return false;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
    const parts = h.split('.').map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      if (parts[0] === 127 || parts[0] === 10) return true;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      if (parts[0] === 192 && parts[1] === 168) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Kompakt-Status für den Poll — genau die Felder, die das Portal anzeigt.
// Quelle ist wie im Leitstand der Poller-Snapshot (IPC), nie Web-Prozess-
// lokales state — sonst bleibt alles leer im Split-Prozess-Betrieb.
function roundEur(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// Lizenz der Anlage fürs Portal (Pro aktiv? lizenzierte kWp? eingetragene
// Anlagengröße?). Ohne Pro darf das Portal nur eine Lizenz einspielen — Status,
// Support-Tunnel und Updates erst mit aktiver Pro-Lizenz. Kein Schlüssel,
// keine Maschinendatei (getState schwärzt beides).
export function buildLicenseInfo(ctx) {
  const ls = ctx.licenseService;
  if (!ls || typeof ls.getState !== 'function') return null;
  let s;
  try { s = ls.getState() || {}; } catch { return null; }
  const kwp = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v) * 10) / 10 : null);
  return {
    proActive: typeof ls.isProActive === 'function' ? ls.isProActive() === true : false,
    status: String(s.effective_status || s.status || 'none'),
    kind: s.license_kind || null,
    maxKwp: kwp(s.max_kwp),
    systemKwp: kwp(s.system_kwp),
    capacityOk: s.capacity_ok !== false,
  };
}

// ── Tagesbericht ─────────────────────────────────────────────────────────────
// Nach jedem abgeschlossenen Tag meldet die Anlage dem Portal den Tagesertrag
// und den Direktvermarktungs-Erlös des Monats bis dahin (wie die DV-Karte der
// Historie). Das Portal speichert beides — die Werte bleiben dort sichtbar,
// auch wenn die Anlage offline ist. Fehlende Tage (Anlage war offline) werden
// nachgeholt, höchstens DAY_REPORT_BACKLOG Tage zurück, einer je Poll.
export const DAY_REPORT_BACKLOG = 31;

export function localDateIso(ms, timeZone = 'Europe/Berlin') {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
function addDaysIso(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Nächster zu meldender Tag: der Tag nach dem zuletzt gemeldeten, frühestens
// DAY_REPORT_BACKLOG Tage zurück; beim ersten Mal nur „gestern“. null = aktuell.
export function nextReportDay(lastReported, yesterday) {
  if (!lastReported) return yesterday;
  if (lastReported >= yesterday) return null;
  const floor = addDaysIso(yesterday, -(DAY_REPORT_BACKLOG - 1));
  const next = addDaysIso(lastReported, 1);
  return next < floor ? floor : next;
}

// null/undefined/'' bleiben null — „unbekannt“ ist nicht „0 €“ (Number(null) === 0).
const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const num2 = (v) => (isNum(v) ? Math.round(Number(v) * 100) / 100 : null);
const num0 = (v) => (isNum(v) ? Math.round(Number(v)) : null);

// Tages- und Monats-Zusammenfassung → kompakter Bericht (nur Zahlen).
// withMonth: nur beim NEUESTEN Tag. Die Monats-Zusammenfassung umfasst immer den
// ganzen Monat bis jetzt — bei nachgeholten älteren Tagen stünde sonst ein
// neuerer Stand unter einem alten Datum. asOf = echter Rechenzeitpunkt.
export async function buildDayReport(ctx, day, { withMonth = true, nowMs = Date.now() } = {}) {
  const getSummary = ctx.historyApi?.getSummary;
  if (typeof getSummary !== 'function') return null;
  const d = await getSummary({ view: 'day', date: day });
  const m = withMonth ? await getSummary({ view: 'month', date: `${day.slice(0, 7)}-01` }) : null;
  const dk = d?.body?.kpis || d?.kpis;
  const mk = m?.body?.kpis || m?.kpis;
  if (!dk) return null;
  return {
    day,
    netEur: num2(dk.netEur),
    exportRevenueEur: num2(dk.exportRevenueEur),
    importCostEur: num2(dk.importCostEur),
    exportKwh: num2(dk.exportKwh),
    pvKwh: num2(dk.pvKwh),
    month: mk ? {
      month: day.slice(0, 7),
      asOf: new Date(nowMs).toISOString(),
      dvRevenueEur: num2(mk.dvRevenueEur ?? mk.exportRevenueEur),
      exportRevenueEur: num2(mk.exportRevenueEur),
      marketPremiumEur: num2(mk.marketPremiumEur),
      exportKwh: num0(mk.exportKwh),
      dvRevenueCtKwh: num2(mk.dvRevenueCtKwh),
    } : null,
  };
}

function proActive(ctx) {
  try { return ctx.licenseService?.isProActive?.() === true; } catch { return false; }
}

export function buildCompactStatus(ctx, now = Date.now()) {
  const payload = (ctx.getCachedRuntimeStatusPayload && ctx.getCachedRuntimeStatusPayload())
    || (ctx.buildFallbackStatusPayload && ctx.buildFallbackStatusPayload(now))
    || {};
  const v = payload.victron || {};
  const alarms = buildVictronAlarmsPayload(v.alarms, now, ctx.getCfg()?.victron?.alarms?.pollIntervalMs);
  return {
    ts: new Date(now).toISOString(),
    soc: v.soc ?? null,
    batteryPowerW: v.batteryPowerW ?? null,
    pvTotalW: v.pvTotalW ?? v.pvPowerW ?? null,
    gridSetpointW: v.gridSetpointW ?? null,
    // Netzübergabepunkt (gemessen) — getrennt, damit das Portal kein
    // Vorzeichen-Setting kennen muss; ohne gültigen Zähler null.
    gridImportW: payload.meter?.ok === false ? null : (v.gridImportW ?? null),
    gridExportW: payload.meter?.ok === false ? null : (v.gridExportW ?? null),
    // Hausverbrauch (gemessen oder aus der Energiebilanz abgeleitet)
    loadW: v.selfConsumptionW ?? null,
    minSocPct: v.minSocPct ?? null,
    alarmsActive: alarms.active.length,
    alarmsSeverity: alarms.severity || 0,
    alarmsStale: !!alarms.stale,
    // Not-Halt ist Web-Prozess-state (state.ctrl), nicht Teil des Poller-
    // Snapshots; der Freeze-Wächter schreibt victron.freeze = { active, … }.
    emergencyStop: !!ctx.state?.ctrl?.discretionaryWritesPaused,
    telemetryFrozen: !!v.freeze?.active,
    supportTunnelOpen: !!(ctx.supportTunnel && ctx.supportTunnel.liteStatus && ctx.supportTunnel.liteStatus().open),
    // Tagesertrag (heute, wie im Leitstand): Netto = Einspeiseerlös − Bezugskosten.
    todayNetEur: roundEur(payload.costs?.netEur),
    todayRevenueEur: roundEur(payload.costs?.revenueEur),
    todayCostEur: roundEur(payload.costs?.costEur),
    version: (ctx.getAppVersion && ctx.getAppVersion().versionLabel) || null,
  };
}

// HTTP POST/GET ohne externe Dependencies (node:http/-https), damit der
// Client in jeder Umgebung ohne Fetch-Polyfill laufen kann.
function request(urlStr, { method = 'POST', headers = {}, body, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('invalid_url')); }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body != null ? JSON.stringify(body) : null;
    const req = lib.request(u, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(payload != null ? { 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

export function createInstallerPortalClient(ctx = {}, deps = {}) {
  const fsImpl = deps.fs || fs;
  const now = deps.now || (() => Date.now());
  const fetchImpl = deps.fetchImpl || request;
  const pushLog = (typeof ctx.pushLog === 'function') ? ctx.pushLog : () => {};
  const pollIntervalMs = Number(deps.pollIntervalMs) || POLL_INTERVAL_MS_DEFAULT;
  // Kommando-Ausführung in Tests überschreibbar; Default: Loopback gegen die
  // eigenen /api/*-Endpunkte (gleiche Guards wie im UI-Klickweg).
  const execCommandImpl = deps.execCommand || ((cmd) => execLoopback(cmd));

  function dataDir() {
    if (typeof ctx.getDataDir === 'function') return ctx.getDataDir() || '.';
    return process.env.DV_DATA_DIR || '.';
  }
  function sidecarPath() { return path.join(dataDir(), SIDECAR_NAME); }
  function loadSidecar() {
    try {
      const o = JSON.parse(fsImpl.readFileSync(sidecarPath(), 'utf8'));
      return (o && typeof o === 'object' && o.portalUrl) ? o : null;
    } catch { return null; }
  }
  function saveSidecar(o) {
    const p = sidecarPath();
    const tmp = `${p}.tmp`;
    fsImpl.writeFileSync(tmp, JSON.stringify(o, null, 2));
    fsImpl.renameSync(tmp, p);
  }
  function clearSidecar() {
    try { fsImpl.unlinkSync(sidecarPath()); } catch { /* war nicht da */ }
  }

  // Loopback gegen die eigene HTTP-Schnittstelle — bewusster Umweg über die
  // echten Routen, damit service-actions-/Tunnel-Guards nicht dupliziert
  // werden.
  function execLoopback(cmd) {
    const cfg = ctx.getCfg() || {};
    const port = Number(cfg.httpPort) || 80;
    const base = `http://127.0.0.1:${port}`;
    // Verbindung immer an 127.0.0.1 — aber mit einem Host-Header, den die
    // Host-Allowlist akzeptiert (die hat KEINEN Loopback-Bypass: ist
    // allowedHosts gesetzt, würde "127.0.0.1:<port>" sonst abgewiesen).
    const allowed = Array.isArray(cfg.allowedHosts) ? cfg.allowedHosts.filter(Boolean) : [];
    const hostHdr = allowed.length ? { host: String(allowed[0]) } : {};
    const auth = 'Bearer ' + (cfg.apiToken || '');
    const args = cmd.args || {};
    if (cmd.type === 'open_tunnel') {
      const body = { ttlMin: Number(args.ttlMin) || 60 };
      // Ohne apiToken zählt der Bearer nicht → Tunnel-UI-Nonce in-process holen.
      if (!cfg.apiToken) body.uiToken = ctx.supportTunnel?.status?.()?.uiToken;
      return fetchImpl(`${base}/api/support/tunnel/open`, {
        method: 'POST', headers: { ...hostHdr, authorization: auth }, body,
      });
    }
    if (cmd.type === 'close_tunnel') {
      return fetchImpl(`${base}/api/support/tunnel/close`, {
        method: 'POST', headers: { ...hostHdr, authorization: auth }, body: {},
      });
    }
    if (cmd.type === 'license_activate') {
      // Lizenz für den Kunden einspielen — gleicher Weg wie in den Einstellungen.
      return fetchImpl(`${base}/api/license/activate`, {
        method: 'POST', headers: { ...hostHdr, authorization: auth }, body: { key: String(args.key || '') },
      });
    }
    if (cmd.type === 'updates_check') {
      return fetchImpl(`${base}/api/admin/update/check`, {
        method: 'GET', headers: { ...hostHdr, authorization: auth },
      });
    }
    return Promise.resolve({ status: 400, json: { ok: false, error: 'unknown_command' } });
  }

  // Live-Schalter des Kunden (installerPortal.enabled) — gilt für den
  // ausgehenden Pfad genauso wie für die WAN-Endpunkte.
  function isEnabled() {
    return (ctx.getCfg() || {}).installerPortal?.enabled === true;
  }
  function tunnelAllowed() {
    return (ctx.getCfg() || {}).installerPortal?.allowTunnel === true;
  }

  // Kopplungs-Generation: claim/disconnect zählen hoch. Ein Poll, der beim
  // Trennen noch unterwegs ist, erkennt so, dass seine Kopplung nicht mehr
  // gilt — er führt dann keine Kommandos mehr aus und schreibt das Sidecar
  // NICHT wieder her (sonst würde "Trennen" rückgängig gemacht).
  let generation = 0;
  function stillCurrent(gen, sc) {
    if (gen !== generation || !isEnabled()) return false;
    const live = loadSidecar();
    return !!(live && live.applianceToken === sc.applianceToken);
  }

  // Höchstens ein Poll gleichzeitig — ein langsames Kommando (Tunnel-Aufbau)
  // darf sich nicht mit dem nächsten Intervall überholen (Doppelausführung).
  let inflight = null;
  function pollOnce() {
    if (inflight) return inflight;
    inflight = doPoll().finally(() => { inflight = null; });
    return inflight;
  }

  // Fehler ans Portal (Christin 2026-10-01): alles aus dem Audit-Log, was als
  // Fehler gilt (…_error, …_failed, MQTT), ab dem Quittungs-Cursor, aufsteigend,
  // höchstens 300 je Poll. Wiederholt, bis das Portal quittiert (errorsAck);
  // erst dann kürzt log-retention.js lokal auf 24 h / 7 Tage.
  const ERRORS_PER_POLL = 300;
  async function takeErrors(sc) {
    const db = ctx.db;
    if (!db || typeof db.query !== 'function') return { errors: [], reset: false };
    const from = Number(sc.errorAckId) || 0;
    try {
      const res = await db.query(
        `SELECT id, ts_utc, event_type, severity, payload FROM audit_log
          WHERE ${AUDIT_ERROR_SQL} AND id > $1 ORDER BY id LIMIT ${ERRORS_PER_POLL}`, [from]);
      const errors = (res.rows || []).map((row) => ({
        id: Number(row.id),
        ts: new Date(row.ts_utc).toISOString(),
        type: String(row.event_type || '').slice(0, 200),
        sev: String(row.severity || 'error'),
        msg: (row.payload == null ? '' : JSON.stringify(row.payload)).slice(0, 1000),
      }));
      // Datenbank neu (Geräte-Tausch ohne DB-Übernahme): lokale ids liegen unter
      // dem Portal-Cursor — einmal zurücksetzen, sonst verwirft das Portal alles.
      let reset = false;
      if (!errors.length && from > 0) {
        const mx = await db.query('SELECT coalesce(max(id), 0) AS m FROM audit_log');
        reset = Number(mx.rows?.[0]?.m) < from;
      }
      return { errors, reset };
    } catch {
      return { errors: [], reset: false };
    }
  }

  async function doPoll() {
    if (!isEnabled()) return { skipped: true, reason: 'disabled' };
    const sc = loadSidecar();
    if (!sc || !sc.applianceToken) return { skipped: true };
    if (sc.revoked) return { skipped: true, reason: 'revoked' };
    const applianceId = readApplianceId(dataDir(), fsImpl);
    if (!applianceId) return { skipped: true, reason: 'no_appliance_id' };
    const gen = generation;
    // Tagesbericht: fertig gerechneten beilegen, sonst im Hintergrund anstoßen.
    const pro = proActive(ctx);
    const dayReport = pro ? takeDayReport(sc) : null;
    const errBatch = sc.approved ? await takeErrors(sc) : { errors: [], reset: false };
    try {
      const r = await fetchImpl(`${sc.portalUrl}/api/poll`, {
        method: 'POST',
        headers: { 'x-appliance-token': sc.applianceToken },
        // Ohne Pro-Lizenz nur die Lizenz-Info, keine Live-Werte.
        body: {
          applianceId,
          license: buildLicenseInfo(ctx),
          status: pro ? buildCompactStatus(ctx, now()) : null,
          ...(dayReport ? { dayReport } : {}),
          ...(errBatch.errors.length ? { errors: errBatch.errors } : {}),
          ...(errBatch.reset ? { errorsReset: true } : {}),
        },
      });
      if (!stillCurrent(gen, sc)) return { ok: false, aborted: true };
      if (r.status === 401 || r.status === 410) {
        // Token widerrufen/abgelehnt — Kopplung gilt als tot, weitere Polls
        // unterbleiben bis zum Trennen/Neukoppeln durch den Kunden.
        sc.lastPollAt = new Date(now()).toISOString();
        sc.lastError = r.status === 410 ? 'pairing_declined' : 'token_invalid';
        sc.revoked = true;
        saveSidecar(sc);
        pushLog('installer_portal_poll_revoked', { portalUrl: sc.portalUrl });
        return { ok: false, revoked: true };
      }
      if (!r.json || !r.json.ok) throw new Error(r.json?.error || `poll_http_${r.status}`);
      const approved = r.json.approved !== false;
      // Ohne Freigabe im Portal werden keine Kommandos angenommen.
      const commands = (approved && Array.isArray(r.json.commands)) ? r.json.commands : [];
      const results = [];
      for (const cmd of commands) {
        if (!cmd || !COMMAND_TYPES.includes(cmd.type)) { results.push({ id: cmd?.id, ok: false, error: 'unknown_command' }); continue; }
        if (!stillCurrent(gen, sc)) return { ok: false, aborted: true };
        // Ohne aktive Pro-Lizenz ist das Portal auf „Lizenz einspielen“
        // beschränkt (je Kommando neu geprüft — ein vorheriges license_activate
        // im selben Durchlauf kann die Lizenz gerade aktiviert haben).
        if (cmd.type !== 'license_activate' && !proActive(ctx)) {
          results.push({ id: cmd.id, ok: false, status: 403, result: { ok: false, error: 'license_required' } });
          pushLog('installer_portal_command_denied', { type: cmd.type, reason: 'license_required' });
          continue;
        }
        if (cmd.type === 'open_tunnel' && !tunnelAllowed()) {
          results.push({ id: cmd.id, ok: false, status: 403, result: { ok: false, error: 'tunnel_not_permitted' } });
          pushLog('installer_portal_command_denied', { type: cmd.type });
          continue;
        }
        let out;
        try { out = await execCommandImpl(cmd); }
        catch (e) { out = { status: 0, json: { ok: false, error: String(e.message || e).slice(0, 160) } }; }
        const result = {
          id: cmd.id,
          ok: !!(out.json && out.json.ok),
          status: out.status,
          result: out.json ?? null,
        };
        results.push(result);
        pushLog('installer_portal_command_executed', { type: cmd.type, ok: result.ok });
      }
      if (results.length && stillCurrent(gen, sc)) {
        try {
          await fetchImpl(`${sc.portalUrl}/api/command-result`, {
            method: 'POST',
            headers: { 'x-appliance-token': sc.applianceToken },
            body: { applianceId, results },
          });
        } catch { /* Ergebnis-Report ist best-effort */ }
      }
      if (!stillCurrent(gen, sc)) return { ok: false, aborted: true };
      sc.lastPollAt = new Date(now()).toISOString();
      sc.lastError = null;
      sc.approved = approved;
      // Nur nach Freigabe speichert das Portal den Bericht — dann gilt er als gemeldet.
      if (dayReport && approved) { sc.lastDayReported = dayReport.day; pendingReport = null; }
      // Quittung: nie über das hinaus, was wir in DIESEM Poll geschickt haben.
      if (approved && Number.isFinite(Number(r.json.errorsAck))) {
        const sentMax = errBatch.errors.length ? errBatch.errors[errBatch.errors.length - 1].id : null;
        if (errBatch.reset) sc.errorAckId = 0;
        else if (sentMax != null) sc.errorAckId = Math.max(Number(sc.errorAckId) || 0, Math.min(Number(r.json.errorsAck), sentMax));
      }
      saveSidecar(sc);
      return { ok: true, approved: sc.approved, executed: results.length };
    } catch (e) {
      if (!stillCurrent(gen, sc)) return { ok: false, aborted: true };
      sc.lastError = String(e.message || e).slice(0, 200);
      sc.lastPollAt = new Date(now()).toISOString();
      saveSidecar(sc);
      return { ok: false, error: sc.lastError };
    }
  }

  // Tagesbericht vorbereiten: wird im Hintergrund gerechnet (Tages- und
  // Monats-Zusammenfassung) und dem NÄCHSTEN Poll beigelegt — der Poll selbst
  // wartet nie darauf.
  let pendingReport = null;   // { day, report } fertig zum Mitschicken
  let reportRunning = false;
  function takeDayReport(sc) {
    const tz = (ctx.getCfg() || {}).schedule?.timezone || 'Europe/Berlin';
    // Kalendertag zurück — nicht „jetzt − 24 h“ (am Zeitumstellungstag wäre das
    // zwischen 23 und 24 Uhr noch HEUTE).
    const yesterday = addDaysIso(localDateIso(now(), tz), -1);
    const day = nextReportDay(sc.lastDayReported || null, yesterday);
    if (!day) return null;
    if (pendingReport && pendingReport.day === day) return pendingReport.report;
    if (!reportRunning) {
      reportRunning = true;
      // Monatswert beim neuesten Tag UND beim letzten Tag jedes abgeschlossenen
      // Monats (sonst bliebe ein über den Monatswechsel verpasster Monat
      // dauerhaft unvollständig). Die Monats-Zusammenfassung ist dann vollständig.
      buildDayReport(ctx, day, { withMonth: day === yesterday || addDaysIso(day, 1).slice(0, 7) !== day.slice(0, 7), nowMs: now() })
        .then((report) => { if (report) pendingReport = { day, report }; })
        .catch(() => { /* nächster Poll versucht es erneut */ })
        .finally(() => { reportRunning = false; });
    }
    return null;
  }

  let timer = null;
  function startPolling() {
    if (timer) return;
    // Erster Poll nach 15 s (Port freiholen), dann im Takt. beides unref —
    // der Poller darf einen Test-/Shutdown-Prozess nicht am Exit hindern.
    const first = setTimeout(() => pollOnce(), Math.min(15_000, pollIntervalMs));
    if (first.unref) first.unref();
    timer = setInterval(() => pollOnce(), pollIntervalMs);
    if (timer.unref) timer.unref();
  }

  // Pairing: Anlage → Portal. Der Code ist der Nachweis, dass der
  // Installateur die Anlage richtig identifiziert hat; das Portal schickt
  // sein Freigabe-Verhalten im Response (approved=false → wartet noch).
  async function claim({ portalUrl, pairingCode, name }) {
    const url = String(portalUrl || '').trim().replace(/\/+$/, '');
    if (!isAllowedPortalUrl(url)) throw new Error('portal_url_not_allowed');
    if (!PAIRING_CODE_RE.test(String(pairingCode || ''))) throw new Error('pairing_code_invalid');
    const applianceId = readApplianceId(dataDir(), fsImpl);
    if (!applianceId) throw new Error('appliance_id_missing');
    const gen = ++generation;
    const r = await fetchImpl(`${url}/api/pair/claim`, {
      method: 'POST',
      body: {
        applianceId,
        code: String(pairingCode),
        name: String(name || '').slice(0, 80) || undefined,
        license: buildLicenseInfo(ctx),
      },
    });
    if (r.status !== 200 || !r.json || !r.json.ok) {
      throw new Error((r.json && r.json.error) || `claim_http_${r.status}`);
    }
    if (gen !== generation) {
      // Kunde hat während der laufenden Anfrage getrennt (oder neu gekoppelt):
      // Antwort verwerfen, NICHT speichern — und das Portal best-effort
      // informieren, damit dort keine verwaiste Anfrage stehen bleibt.
      const token = r.json.applianceToken;
      if (token) {
        Promise.resolve().then(() => fetchImpl(`${url}/api/pair/release`, {
          method: 'POST', headers: { 'x-appliance-token': token }, body: { applianceId },
        })).catch(() => {});
      }
      throw new Error('pairing_cancelled');
    }
    const sc = {
      portalUrl: url,
      applianceToken: r.json.applianceToken,
      approved: r.json.status === 'approved',
      pairedAt: new Date(now()).toISOString(),
      lastPollAt: null,
      lastError: null,
    };
    saveSidecar(sc);
    startPolling();
    pushLog('installer_portal_client_paired', { portalUrl: url, status: r.json.status });
    return { ok: true, status: r.json.status, portalUrl: url };
  }

  function status() {
    const sc = loadSidecar();
    if (!sc) return { paired: false };
    return {
      paired: true,
      portalUrl: sc.portalUrl,
      approved: !!sc.approved,
      pairedAt: sc.pairedAt || null,
      lastPollAt: sc.lastPollAt || null,
      lastError: sc.lastError || null,
      revoked: !!sc.revoked,
      applianceId: readApplianceId(dataDir(), fsImpl),
    };
  }

  // Laufende Kopplungs-Anfrage / laufenden Poll verwerfen, OHNE die Kopplung
  // zu löschen — z. B. wenn der Kunde den Portal-Zugang ausschaltet, während
  // claim() noch auf das Portal wartet (sonst schaltet dessen Erfolg den
  // Zugang wieder ein).
  function cancelPending() {
    generation++;
  }

  function disconnect() {
    generation++;
    const sc = loadSidecar();
    clearSidecar();
    // Portal best-effort informieren, damit die Anlage dort frei wird (neuer
    // Code / anderer Installateur). Lokal ist die Trennung schon wirksam.
    const applianceId = readApplianceId(dataDir(), fsImpl);
    if (sc && sc.applianceToken && applianceId) {
      Promise.resolve()
        .then(() => fetchImpl(`${sc.portalUrl}/api/pair/release`, {
          method: 'POST', headers: { 'x-appliance-token': sc.applianceToken }, body: { applianceId },
        }))
        .catch(() => { /* Portal nicht erreichbar — egal */ });
    }
    pushLog('installer_portal_client_disconnected', {});
    return { ok: true };
  }

  /** Höchste vom Portal quittierte Fehler-id (für log-retention.js), sonst null. */
  function errorAckId() {
    if (!isEnabled()) return null;
    const sc = loadSidecar();
    if (!sc || !sc.approved || sc.revoked) return null;
    const v = Number(sc.errorAckId);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  return { claim, status, disconnect, cancelPending, pollOnce, startPolling, errorAckId, buildCompactStatus: (n) => buildCompactStatus(ctx, n) };
}
