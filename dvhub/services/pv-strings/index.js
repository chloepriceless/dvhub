/**
 * PV-Strings: Erzeugung je String/Tracker erfassen, speichern und fuer die
 * pvnode-Kalibrierung aufbereiten ("Solar-Logger", Stufe 1+2).
 *
 * Quelle Stufe 1: Victron-MPPT-Tracker ueber die VRM-API (widgets/Graph,
 * Attribut PVP<n> = "PV power on tracker n+1"). VRM liefert 1-Minuten-Werte
 * rueckwirkend (prod: ~6 Monate), also Nachladen und laufende Erfassung ueber
 * denselben Weg. Gespeichert als 15-Minuten-Mittel in timeseries_samples:
 *   series_key pv_string_<id>_w, scope history, source vrm_import, 900 s, W
 * Damit erscheinen die Reihen auch im Daten-Explorer.
 *
 * pvnode (Stand 2026-09, docs/en/v2/api/measurements): Kalibrierung nur per
 * Web-Upload, je String eine CSV "timestamp;pv_power", Watt, Zeitstempel mit
 * Offset, hoechstens 15 min Abstand, mindestens ~3 Monate. Die Datei erzeugt
 * buildPvnodeCsv(); hochladen muss der Betreiber selbst (keine API).
 */

export const PV_STRING_SERIES_PREFIX = 'pv_string_';
const VRM_BASE = 'https://vrmapi.victronenergy.com';
const SLOT_S = 900;
const DAY_S = 86400;

export function seriesKeyFor(id) {
  return `${PV_STRING_SERIES_PREFIX}${id}_w`;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Konfigurierte Quellen, bereinigt. Unbrauchbare Eintraege fallen weg. */
export function resolvePvStringSources(cfg) {
  const list = Array.isArray(cfg?.pvStrings?.sources) ? cfg.pvStrings.sources : [];
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const id = String(s.id || '').toLowerCase();
    if (!ID_RE.test(id) || seen.has(id)) continue;
    if (s.kind !== 'victron_vrm_tracker') continue;
    const instance = Number(s.instance);
    const tracker = Number(s.tracker);
    if (!Number.isInteger(instance) || instance < 0 || !Number.isInteger(tracker) || tracker < 0 || tracker > 7) continue;
    seen.add(id);
    out.push({
      id,
      label: String(s.label || id).slice(0, 80),
      kind: s.kind,
      instance,
      tracker,
      kwp: Number(s.kwp) > 0 ? Number(s.kwp) : null,
      seriesKey: seriesKeyFor(id)
    });
  }
  return out;
}

/**
 * 1-Minuten-Punkte [[unixSec, W], …] → 15-Minuten-Mittel. Ein Slot zaehlt nur,
 * wenn mindestens die Haelfte seiner Zeit belegt ist (sonst Luecke statt eines
 * Mittels aus zwei Werten). Die Belegung wird aus dem kleinsten Punktabstand
 * geschaetzt, damit auch groebere VRM-Aufloesungen funktionieren.
 */
export function aggregateToSlots(points, { slotS = SLOT_S, minCoverage = 0.5 } = {}) {
  const pts = (Array.isArray(points) ? points : [])
    .filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
    .map((p) => [Number(p[0]), Number(p[1])])
    .sort((a, b) => a[0] - b[0]);
  if (!pts.length) return [];
  let stepS = slotS;
  for (let i = 1; i < pts.length; i += 1) {
    const d = pts[i][0] - pts[i - 1][0];
    if (d > 0 && d < stepS) stepS = d;
  }
  const buckets = new Map();
  for (const [ts, w] of pts) {
    const slot = Math.floor(ts / slotS) * slotS;
    const b = buckets.get(slot) || { sum: 0, n: 0 };
    b.sum += w;
    b.n += 1;
    buckets.set(slot, b);
  }
  const needed = Math.max(1, Math.floor((slotS / stepS) * minCoverage));
  const out = [];
  for (const [slot, b] of [...buckets].sort((a, b2) => a[0] - b2[0])) {
    if (b.n < needed) continue;
    out.push({ slotStartS: slot, avgW: Math.max(0, Math.round(b.sum / b.n)), n: b.n });
  }
  return out;
}

/** "2026-06-01T12:00:00+02:00" in der Anlagen-Zeitzone. */
export function isoWithOffset(ms, timeZone = 'Europe/Berlin') {
  const d = new Date(ms);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset'
  }).formatToParts(d).map((p) => [p.type, p.value]));
  const off = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.replace('GMT', '');
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${off}`;
}

/** CSV fuer den pvnode-Upload: Kopfzeile + "zeit;watt" je 15-Minuten-Slot. */
export function buildPvnodeCsv(rows, { timeZone = 'Europe/Berlin' } = {}) {
  const lines = ['timestamp;pv_power'];
  for (const r of rows) {
    const ms = Date.parse(r.ts);
    const w = Number(r.value);
    if (!Number.isFinite(ms) || !Number.isFinite(w)) continue;
    lines.push(`${isoWithOffset(ms, timeZone)};${Math.max(0, Math.round(w))}`);
  }
  return `${lines.join('\n')}\n`;
}

function vrmCreds(cfg) {
  const hi = cfg?.telemetry?.historyImport || {};
  if (!hi.vrmPortalId || !hi.vrmToken) return null;
  return { portalId: String(hi.vrmPortalId), token: String(hi.vrmToken) };
}

/**
 * Ein VRM-Graph-Abruf fuer mehrere Tracker EINES Ladereglers.
 * @returns {Promise<{ ok: boolean, byTracker?: Map<number, Array>, names?: Map<number,string>, error?: string }>}
 */
export async function fetchVrmTrackers({ creds, instance, trackers, startS, endS, fetchImpl = fetch }) {
  const q = new URLSearchParams();
  for (const t of trackers) q.append('attributeCodes[]', `PVP${t}`);
  q.set('instance', String(instance));
  q.set('start', String(startS));
  q.set('end', String(endS));
  const url = `${VRM_BASE}/v2/installations/${encodeURIComponent(creds.portalId)}/widgets/Graph?${q}`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json', 'x-authorization': `Token ${creds.token}` }, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!res.ok) return { ok: false, error: `VRM HTTP ${res.status}`, status: res.status };
  const body = await res.json().catch(() => null);
  const rec = body?.records;
  if (!body?.success || !rec) return { ok: false, error: 'VRM: unerwartete Antwort' };
  const byTracker = new Map();
  const names = new Map();
  for (const [attrId, meta] of Object.entries(rec.meta || {})) {
    const m = /^PVP(\d)$/.exec(meta?.code || '');
    if (!m) continue;
    const t = Number(m[1]);
    byTracker.set(t, Array.isArray(rec.data?.[attrId]) ? rec.data[attrId] : []);
    if (Array.isArray(meta.customName) && meta.customName[0]) names.set(t, String(meta.customName[0]));
  }
  return { ok: true, byTracker, names };
}

/**
 * Welche Tracker hat die Anlage? Aus der VRM-Diagnose (PVn<n> = Name,
 * PVe<n> = aktiv). Fuer den Vorschlag in der Oberflaeche.
 */
export async function discoverVrmTrackers({ creds, fetchImpl = fetch }) {
  const url = `${VRM_BASE}/v2/installations/${encodeURIComponent(creds.portalId)}/diagnostics?count=1000`;
  const res = await fetchImpl(url, { headers: { accept: 'application/json', 'x-authorization': `Token ${creds.token}` }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) return { ok: false, error: `VRM HTTP ${res.status}` };
  const body = await res.json().catch(() => null);
  const byKey = new Map();
  for (const r of body?.records || []) {
    const m = /^PV([neP])(\d)$/.exec(r.code || '');
    if (!m || !/solar/i.test(String(r.Device || ''))) continue;
    const key = `${r.instance}:${m[2]}`;
    const e = byKey.get(key) || { instance: Number(r.instance), tracker: Number(m[2]), name: null, enabled: null, device: r.Device };
    if (m[1] === 'n') e.name = r.formattedValue || null;
    if (m[1] === 'e') e.enabled = /enabled/i.test(String(r.formattedValue || ''));
    byKey.set(key, e);
  }
  const trackers = [...byKey.values()].sort((a, b) => a.instance - b.instance || a.tracker - b.tracker);
  return { ok: true, trackers };
}

export function createPvStringsService(ctx) {
  const { getCfg, pushLog = () => {}, fetchImpl = (...a) => fetch(...a), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = ctx;
  const store = () => ctx.telemetryStore;
  const status = { lastSyncAt: null, lastError: null, backfill: { running: false, doneDays: 0, totalDays: 0, startedAt: null, finishedAt: null, error: null } };
  let timer = null;

  function toRows(source, slots) {
    return slots.map((s) => ({
      seriesKey: source.seriesKey,
      scope: 'history',
      source: 'vrm_import',
      quality: 'backfilled',
      ts: new Date(s.slotStartS * 1000).toISOString(),
      resolutionSeconds: SLOT_S,
      value: s.avgW,
      unit: 'W',
      meta: { kind: source.kind, instance: source.instance, tracker: source.tracker, n: s.n }
    }));
  }

  /** Einen Zeitraum fuer alle Quellen holen und speichern. */
  async function syncWindow(startS, endS) {
    const cfg = getCfg();
    const creds = vrmCreds(cfg);
    const sources = resolvePvStringSources(cfg);
    if (!creds) return { ok: false, error: 'VRM-Zugang fehlt (Integrationen → VRM Cloud)' };
    if (!sources.length) return { ok: false, error: 'keine Strings konfiguriert' };
    const byInstance = new Map();
    for (const s of sources) {
      if (!byInstance.has(s.instance)) byInstance.set(s.instance, []);
      byInstance.get(s.instance).push(s);
    }
    let written = 0;
    let points = 0;
    for (const [instance, list] of byInstance) {
      const r = await fetchVrmTrackers({ creds, instance, trackers: list.map((s) => s.tracker), startS, endS, fetchImpl });
      if (!r.ok) return { ok: false, error: r.error, status: r.status };
      const rows = [];
      for (const s of list) {
        const pts = r.byTracker.get(s.tracker) || [];
        points += pts.length;
        // Nur ganze Slots innerhalb des Fensters: der angeschnittene letzte
        // Slot kommt beim naechsten Lauf vollstaendig.
        const slots = aggregateToSlots(pts).filter((x) => x.slotStartS >= startS && x.slotStartS + SLOT_S <= endS);
        rows.push(...toRows(s, slots));
      }
      if (rows.length && store()?.writeSamples) {
        await store().writeSamples(rows);
        written += rows.length;
      }
    }
    return { ok: true, written, points };
  }

  /** Laufende Erfassung: die letzten 3 Stunden (VRM liefert mit Verzug). */
  async function syncRecent() {
    const cfg = getCfg();
    if (cfg?.pvStrings?.enabled !== true) return { skipped: 'disabled' };
    const endS = Math.floor(now() / 1000 / SLOT_S) * SLOT_S;
    const r = await syncWindow(endS - 3 * 3600, endS);
    if (r.ok) { status.lastSyncAt = new Date(now()).toISOString(); status.lastError = null; }
    else { status.lastError = r.error; pushLog('pv_strings_sync_error', { error: r.error }); }
    return r;
  }

  /**
   * Nachladen, rueckwaerts Tag fuer Tag bis `days` oder bis VRM drei Tage in
   * Folge nichts liefert (Beginn der Aufzeichnung). Ein Abruf je Tag und
   * Laderegler, 1,5 s Pause — VRM drosselt sonst.
   */
  async function backfill({ days } = {}) {
    if (status.backfill.running) return { ok: false, error: 'laeuft bereits' };
    const cfg = getCfg();
    const total = Math.max(1, Math.min(730, Number(days) || Number(cfg?.pvStrings?.backfillDays) || 365));
    Object.assign(status.backfill, { running: true, doneDays: 0, totalDays: total, startedAt: new Date(now()).toISOString(), finishedAt: null, error: null });
    pushLog('pv_strings_backfill_start', { days: total });
    let emptyRun = 0;
    try {
      const todayS = Math.floor(now() / 1000 / DAY_S) * DAY_S;
      for (let d = 0; d < total; d += 1) {
        const endS = todayS - d * DAY_S;
        const r = await syncWindow(endS - DAY_S, endS);
        if (!r.ok) {
          if (r.status === 429) { await sleep(30_000); d -= 1; continue; }
          throw new Error(r.error);
        }
        status.backfill.doneDays = d + 1;
        emptyRun = r.points === 0 ? emptyRun + 1 : 0;
        if (emptyRun >= 3) break;
        await sleep(1500);
      }
      pushLog('pv_strings_backfill_done', { days: status.backfill.doneDays });
    } catch (e) {
      status.backfill.error = e.message;
      pushLog('pv_strings_backfill_error', { error: e.message, doneDays: status.backfill.doneDays });
    } finally {
      status.backfill.running = false;
      status.backfill.finishedAt = new Date(now()).toISOString();
    }
    return { ok: !status.backfill.error, doneDays: status.backfill.doneDays, error: status.backfill.error };
  }

  /** Gespeicherte 15-Minuten-Werte eines Strings. */
  async function readSeries(id, { start, end }) {
    const source = resolvePvStringSources(getCfg()).find((s) => s.id === id);
    if (!source) return null;
    const rows = await store()?.querySeries?.({ seriesKeys: [source.seriesKey], start, end, maxResolution: SLOT_S }) || [];
    return { source, rows };
  }

  /** Uebersicht: je String Abdeckung und Tagesertraege der letzten 14 Tage. */
  async function overview({ days = 14 } = {}) {
    const cfg = getCfg();
    const sources = resolvePvStringSources(cfg);
    const tz = cfg?.schedule?.timezone || 'Europe/Berlin';
    const endMs = now();
    const out = [];
    for (const s of sources) {
      const all = await store()?.querySeries?.({ seriesKeys: [s.seriesKey], start: new Date(endMs - 800 * DAY_S * 1000).toISOString(), end: new Date(endMs).toISOString(), maxResolution: SLOT_S }) || [];
      const daily = new Map();
      for (const r of all) {
        const ms = Date.parse(r.ts);
        if (ms < endMs - days * DAY_S * 1000) continue;
        const day = isoWithOffset(ms, tz).slice(0, 10);
        daily.set(day, (daily.get(day) || 0) + Number(r.value) * SLOT_S / 3600 / 1000);
      }
      out.push({
        ...s,
        slots: all.length,
        firstTs: all[0]?.ts ? new Date(all[0].ts).toISOString() : null,
        lastTs: all.at(-1)?.ts ? new Date(all.at(-1).ts).toISOString() : null,
        coverageDays: Math.round(all.length / 96),
        dailyKwh: [...daily].sort().map(([day, kwh]) => ({ day, kwh: Math.round(kwh * 100) / 100 }))
      });
    }
    return { enabled: cfg?.pvStrings?.enabled === true, vrmConfigured: Boolean(vrmCreds(cfg)), sources: out, status: getStatus() };
  }

  function getStatus() {
    return { lastSyncAt: status.lastSyncAt, lastError: status.lastError, backfill: { ...status.backfill } };
  }

  function start() {
    if (timer) return;
    // Viertelstuendlich, 5 min nach dem Slot-Ende (VRM braucht etwas).
    const tick = () => { syncRecent().catch((e) => pushLog('pv_strings_sync_error', { error: e.message })); };
    timer = setInterval(tick, 15 * 60 * 1000);
    if (typeof timer.unref === 'function') timer.unref();
    setTimeout(tick, 60_000).unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function discover() {
    const creds = vrmCreds(getCfg());
    if (!creds) return { ok: false, error: 'VRM-Zugang fehlt (Integrationen → VRM Cloud)' };
    return discoverVrmTrackers({ creds, fetchImpl });
  }

  return { start, stop, syncRecent, syncWindow, backfill, readSeries, overview, discover, getStatus };
}
