/**
 * PV-Strings: Erzeugung je String/Tracker erfassen, speichern und fuer die
 * pvnode-Kalibrierung aufbereiten ("Solar-Logger", Stufe 1-3).
 *
 * Quellen:
 * - Victron-MPPT-Tracker ueber die VRM-API (widgets/Graph, Attribut PVP<n> =
 *   "PV power on tracker n+1"). VRM liefert 1-Minuten-Werte rueckwirkend
 *   (prod: ~6 Monate).
 * - Fronius-MPPT ueber die Solar API des Wechselrichters
 *   (GetArchiveData.cgi, Current_/Voltage_DC_String_<n>). Der Wechselrichter
 *   speichert 5-Minuten-Werte selbst (prod: ab Juli 2025).
 *
 * Gespeichert als 5-Minuten-Mittel in timeseries_samples:
 *   series_key pv_string_<id>_w, scope history, 300 s, W
 * Zeitstempel = Beginn des Slots; der Wert ist die mittlere Leistung im
 * Intervall [ts, ts+5 min). Beide Quellen liegen damit auf demselben Raster und
 * lassen sich zu Gruppen addieren (z. B. alle Sued-Strings an verschiedenen
 * Geraeten zu einer Reihe). Ausrichtung gemessen 2026-09-23: Fronius-Wert mit
 * Stempel k passt am besten zum Mittel der VRM-Minutenpunkte in [k-5 min, k)
 * (Kreuzkorrelation an 5 Tagen, jeweils Verschiebung 0 am besten) — Fronius
 * stempelt also das Intervallende.
 * Die aelteren 900-s-Zeilen (Stufe 1+2) bleiben liegen, gelesen wird nur 300 s.
 *
 * pvnode (Stand 2026-09, docs/en/v2/api/measurements): Kalibrierung nur per
 * Web-Upload, je String eine CSV "timestamp;pv_power", Watt, Zeitstempel mit
 * Offset, hoechstens 15 min Abstand, mindestens ~3 Monate. Die Datei erzeugt
 * buildPvnodeCsv(); hochladen muss der Betreiber selbst (keine API).
 */

export const PV_STRING_SERIES_PREFIX = 'pv_string_';
const VRM_BASE = 'https://vrmapi.victronenergy.com';
const SLOT_S = 300;
const DAY_S = 86400;
export const PV_STRING_KINDS = ['victron_vrm_tracker', 'fronius_mppt'];
const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000];

export function seriesKeyFor(id) {
  return `${PV_STRING_SERIES_PREFIX}${id}_w`;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// Hostname oder IPv4, optional mit Port. Kein Schema, kein Pfad: DVhub baut
// die URL selbst und fragt nur die festen Solar-API-Pfade ab.
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/i;

export function normalizeFroniusHost(v) {
  const h = String(v || '').trim().toLowerCase();
  return HOST_RE.test(h) ? h : null;
}

/** Konfigurierte Quellen, bereinigt. Unbrauchbare Eintraege fallen weg. */
export function resolvePvStringSources(cfg) {
  const list = Array.isArray(cfg?.pvStrings?.sources) ? cfg.pvStrings.sources : [];
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const id = String(s.id || '').toLowerCase();
    if (!ID_RE.test(id) || seen.has(id)) continue;
    const base = {
      id,
      label: String(s.label || id).slice(0, 80),
      kind: s.kind,
      kwp: Number(s.kwp) > 0 ? Number(s.kwp) : null,
      seriesKey: seriesKeyFor(id)
    };
    if (s.kind === 'victron_vrm_tracker') {
      const instance = Number(s.instance);
      const tracker = Number(s.tracker);
      if (!Number.isInteger(instance) || instance < 0 || !Number.isInteger(tracker) || tracker < 0 || tracker > 7) continue;
      out.push({ ...base, instance, tracker });
    } else if (s.kind === 'fronius_mppt') {
      const host = normalizeFroniusHost(s.host);
      const mppt = Number(s.mppt);
      if (!host || !Number.isInteger(mppt) || mppt < 1 || mppt > 4) continue;
      out.push({ ...base, host, mppt });
    } else {
      continue;
    }
    seen.add(id);
  }
  return out;
}

/**
 * Gruppen: Summe mehrerer Strings als eigene Reihe (z. B. "Sued gesamt" aus
 * zwei MPPT-RS-Trackern und einem Fronius-MPPT). Ein Slot zaehlt nur, wenn
 * alle Mitglieder einen Wert haben. Mitglieder muessen konfigurierte Strings
 * sein; die Gruppen-ID darf keine String-ID verdecken.
 */
export function resolvePvStringGroups(cfg, sources = resolvePvStringSources(cfg)) {
  const list = Array.isArray(cfg?.pvStrings?.groups) ? cfg.pvStrings.groups : [];
  const byId = new Map(sources.map((s) => [s.id, s]));
  const seen = new Set(byId.keys());
  const out = [];
  for (const g of list) {
    if (!g || typeof g !== 'object') continue;
    const id = String(g.id || '').toLowerCase();
    if (!ID_RE.test(id) || seen.has(id)) continue;
    const members = [...new Set((Array.isArray(g.members) ? g.members : []).map((m) => String(m).toLowerCase()))]
      .filter((m) => byId.has(m));
    if (members.length < 2) continue;
    seen.add(id);
    const kwps = members.map((m) => byId.get(m).kwp);
    out.push({
      id,
      label: String(g.label || id).slice(0, 80),
      kind: 'group',
      members,
      kwp: kwps.every((k) => k > 0) ? Math.round(kwps.reduce((a, b) => a + b, 0) * 100) / 100 : null,
      seriesKey: seriesKeyFor(id)
    });
  }
  return out;
}

/**
 * 1-Minuten-Punkte [[unixSec, W], …] → 5-Minuten-Mittel. Ein Slot zaehlt nur,
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

/** Offset der Zeitzone zu einem Zeitpunkt, in Sekunden (Berlin Sommer: 7200). */
function tzOffsetS(unixS, timeZone) {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(isoWithOffset(unixS * 1000, timeZone));
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60);
}

/** Kalendertag "YYYY-MM-DD" in der Anlagen-Zeitzone. */
export function localDate(unixS, timeZone = 'Europe/Berlin') {
  return isoWithOffset(unixS * 1000, timeZone).slice(0, 10);
}

/** Lokale Mitternacht eines Tages als Unix-Sekunden (auch an DST-Tagen). */
export function localMidnightS(date, timeZone = 'Europe/Berlin') {
  const [y, mo, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d) / 1000;
  let t = guess - tzOffsetS(guess, timeZone);
  t = guess - tzOffsetS(t, timeZone);
  return t;
}

/** Tag davor/danach, reine Kalenderrechnung. */
export function shiftDate(date, days) {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
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
 * Fronius-Archiv eines Tages: DC-Leistung je MPPT als 5-Minuten-Slots.
 * Leistung = Spannung x Strom des jeweiligen Eingangs. Der Archivstempel ist
 * das Intervallende (siehe Kopf), der Slot beginnt 5 min frueher.
 *
 * Der Wechselrichter schlaeft nachts und speichert dann nichts. Hat ein Tag
 * ueberhaupt Werte, sind die Slots vor dem ersten und — wenn der Tag vorbei ist
 * — nach dem letzten Wert 0 W statt Luecke, damit Gruppen auch in der
 * Daemmerung eine Summe haben. Ein Tag ganz ohne Werte bleibt leer (Ausfall).
 *
 * @returns {Promise<{ ok: boolean, byMppt?: Map<number, Array<{slotStartS:number, avgW:number, n:number}>>, error?: string }>}
 */
export async function fetchFroniusDay({ host, mppts, date, timeZone = 'Europe/Berlin', nowS, fetchImpl = fetch }) {
  const q = new URLSearchParams({ Scope: 'System', StartDate: date, EndDate: date });
  for (const m of mppts) { q.append('Channel', `Current_DC_String_${m}`); q.append('Channel', `Voltage_DC_String_${m}`); }
  const url = `http://${host}/solar_api/v1/GetArchiveData.cgi?${q}`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    return { ok: false, error: `Fronius ${host}: ${e.message}` };
  }
  if (!res.ok) return { ok: false, error: `Fronius ${host}: HTTP ${res.status}` };
  const body = await res.json().catch(() => null);
  const code = body?.Head?.Status?.Code;
  if (code == null || code !== 0) return { ok: false, error: `Fronius ${host}: ${body?.Head?.Status?.Reason || 'unerwartete Antwort'}` };
  const dayStartS = localMidnightS(date, timeZone);
  const dayEndS = localMidnightS(shiftDate(date, 1), timeZone);
  const byMppt = new Map(mppts.map((m) => [m, []]));
  for (const node of Object.values(body?.Body?.Data || {})) {
    const startS = Date.parse(node?.Start) / 1000;
    const ch = node?.Data || {};
    for (const m of mppts) {
      const cur = ch[`Current_DC_String_${m}`]?.Values || {};
      const volt = ch[`Voltage_DC_String_${m}`]?.Values || {};
      const slots = byMppt.get(m);
      for (const [k, a] of Object.entries(cur)) {
        const v = volt[k];
        if (!Number.isFinite(Number(a)) || !Number.isFinite(Number(v)) || !Number.isFinite(startS)) continue;
        const endS = startS + Number(k);
        const slotStartS = Math.floor((endS - SLOT_S) / SLOT_S) * SLOT_S;
        slots.push({ slotStartS, avgW: Math.max(0, Math.round(Number(a) * Number(v))), n: 1 });
      }
    }
  }
  for (const [m, slots] of byMppt) {
    if (!slots.length) continue;
    const have = new Map(slots.map((x) => [x.slotStartS, x]));
    const first = Math.min(...have.keys());
    const last = Math.max(...have.keys());
    const dayDone = Number.isFinite(nowS) ? nowS >= dayEndS : true;
    for (let t = dayStartS; t < dayEndS; t += SLOT_S) {
      if (have.has(t)) continue;
      if (t < first || (dayDone && t > last)) have.set(t, { slotStartS: t, avgW: 0, n: 0 });
    }
    byMppt.set(m, [...have.values()].sort((a, b) => a.slotStartS - b.slotStartS));
  }
  return { ok: true, byMppt };
}

/**
 * Welche MPPT-Eingaenge hat ein Fronius? Aus /components/inverter/readable
 * (Nameplate.cnt-dc), dazu die aktuelle Leistung je Eingang.
 */
export async function discoverFroniusMppts({ host, fetchImpl = fetch }) {
  const h = normalizeFroniusHost(host);
  if (!h) return { ok: false, error: 'ungueltige Adresse' };
  let res;
  try {
    res = await fetchImpl(`http://${h}/components/inverter/readable`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    return { ok: false, error: `Fronius ${h} nicht erreichbar (${e.message}) — nachts schlaeft der Wechselrichter` };
  }
  if (!res.ok) return { ok: false, error: `Fronius ${h}: HTTP ${res.status}` };
  const body = await res.json().catch(() => null);
  const dev = Object.values(body?.Body?.Data || {})[0];
  if (!dev) return { ok: false, error: `Fronius ${h}: keine Wechselrichterdaten` };
  const count = Math.min(4, Math.max(1, Number(dev.attributes?.['Nameplate.cnt-dc']) || 2));
  const mppts = [];
  for (let m = 1; m <= count; m += 1) {
    const p = Number(dev.channels?.[`Power_DC_String_${m}`]);
    mppts.push({ host: h, mppt: m, powerW: Number.isFinite(p) ? Math.round(p) : null });
  }
  return { ok: true, host: h, mppts };
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
  const status = { lastSyncAt: null, lastError: null, lastFinalizedDay: null, backfill: { running: false, doneDays: 0, totalDays: 0, startedAt: null, finishedAt: null, error: null } };
  let timer = null;
  const tzOf = (cfg) => cfg?.schedule?.timezone || 'Europe/Berlin';

  function toRows(source, slots, sourceTag) {
    return slots.map((s) => ({
      seriesKey: source.seriesKey,
      scope: 'history',
      source: sourceTag,
      quality: 'backfilled',
      ts: new Date(s.slotStartS * 1000).toISOString(),
      resolutionSeconds: SLOT_S,
      value: s.avgW,
      unit: 'W',
      meta: source.kind === 'fronius_mppt'
        ? { kind: source.kind, host: source.host, mppt: source.mppt }
        : source.kind === 'group'
          ? { kind: 'group', members: source.members }
          : { kind: source.kind, instance: source.instance, tracker: source.tracker, n: s.n }
    }));
  }

  async function write(rows) {
    if (rows.length && store()?.writeSamples) await store().writeSamples(rows);
    return rows.length;
  }

  /** VRM-Tracker fuer [startS, endS). Ein Abruf je Laderegler. */
  async function syncVrm(sources, creds, startS, endS) {
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
        rows.push(...toRows(s, slots, 'vrm_import'));
      }
      written += await write(rows);
    }
    return { ok: true, written, points };
  }

  /** Fronius-MPPTs fuer [startS, endS). Ein Abruf je Geraet und Kalendertag. */
  async function syncFronius(sources, startS, endS, tz) {
    const byHost = new Map();
    for (const s of sources) {
      if (!byHost.has(s.host)) byHost.set(s.host, []);
      byHost.get(s.host).push(s);
    }
    const dates = [];
    for (let d = localDate(startS, tz); localMidnightS(d, tz) < endS; d = shiftDate(d, 1)) dates.push(d);
    const nowS = Math.floor(now() / 1000);
    let written = 0;
    let points = 0;
    for (const [host, list] of byHost) {
      for (const date of dates) {
        const r = await fetchFroniusDay({ host, mppts: [...new Set(list.map((s) => s.mppt))], date, timeZone: tz, nowS, fetchImpl });
        if (!r.ok) return { ok: false, error: r.error };
        const rows = [];
        for (const s of list) {
          const slots = (r.byMppt.get(s.mppt) || []).filter((x) => x.slotStartS >= startS && x.slotStartS + SLOT_S <= endS);
          points += slots.filter((x) => x.n > 0).length;
          rows.push(...toRows(s, slots, 'fronius_import'));
        }
        written += await write(rows);
      }
    }
    return { ok: true, written, points };
  }

  /** Gruppen fuer [startS, endS) aus den gespeicherten Mitglieds-Reihen. */
  async function syncGroups(groups, sources, startS, endS) {
    let written = 0;
    const byId = new Map(sources.map((s) => [s.id, s]));
    for (const g of groups) {
      const keys = g.members.map((m) => byId.get(m).seriesKey);
      const rows = await store()?.querySeries?.({ seriesKeys: keys, start: new Date(startS * 1000).toISOString(), end: new Date(endS * 1000).toISOString(), maxResolution: SLOT_S }) || [];
      const slots = new Map();
      for (const r of rows) {
        if (Number(r.resolution) !== SLOT_S) continue;
        const t = Math.floor(Date.parse(r.ts) / 1000);
        if (!slots.has(t)) slots.set(t, new Map());
        slots.get(t).set(r.key, Number(r.value));
      }
      const out = [];
      for (const [t, vals] of [...slots].sort((a, b) => a[0] - b[0])) {
        if (vals.size !== keys.length) continue;
        out.push({ slotStartS: t, avgW: Math.round([...vals.values()].reduce((a, b) => a + b, 0)), n: vals.size });
      }
      written += await write(toRows(g, out, 'derived'));
    }
    return written;
  }

  /**
   * Einen Zeitraum fuer alle Quellen holen und speichern, danach die Gruppen
   * neu bilden. Faellt eine Quellenart aus, laufen die anderen trotzdem; der
   * Fehler steht im Ergebnis. `skip` ueberspringt Quellenarten (Nachladen,
   * wenn eine Quelle am Beginn ihrer Aufzeichnung angekommen ist).
   */
  async function syncWindow(startS, endS, { skip = new Set() } = {}) {
    const cfg = getCfg();
    const tz = tzOf(cfg);
    const sources = resolvePvStringSources(cfg);
    if (!sources.length) return { ok: false, error: 'keine Strings konfiguriert' };
    const vrm = sources.filter((s) => s.kind === 'victron_vrm_tracker');
    const fronius = sources.filter((s) => s.kind === 'fronius_mppt');
    const result = { ok: true, written: 0, points: 0, bySource: {}, errors: [] };
    if (vrm.length && !skip.has('vrm')) {
      const creds = vrmCreds(cfg);
      const r = creds ? await syncVrm(vrm, creds, startS, endS) : { ok: false, error: 'VRM-Zugang fehlt (Integrationen → VRM Cloud)' };
      result.bySource.vrm = r;
      if (r.ok) { result.written += r.written; result.points += r.points; } else result.errors.push(r.error);
    }
    if (fronius.length && !skip.has('fronius')) {
      const r = await syncFronius(fronius, startS, endS, tz);
      result.bySource.fronius = r;
      if (r.ok) { result.written += r.written; result.points += r.points; } else result.errors.push(r.error);
    }
    const groups = resolvePvStringGroups(cfg, sources);
    if (groups.length) result.written += await syncGroups(groups, sources, startS, endS);
    if (result.errors.length) {
      result.ok = false;
      result.error = result.errors.join(' · ');
      result.status = result.bySource.vrm?.status;
    }
    return result;
  }

  /**
   * Laufende Erfassung: die letzten 3 Stunden (VRM liefert mit Verzug). Einmal
   * am Tag zusaetzlich den ganzen Vortag, damit VRM-Nachzuegler und die
   * Fronius-Nachtnullen des abgeschlossenen Tages vollstaendig sind.
   */
  async function syncRecent() {
    const cfg = getCfg();
    if (cfg?.pvStrings?.enabled !== true) return { skipped: 'disabled' };
    const tz = tzOf(cfg);
    const nowS = Math.floor(now() / 1000);
    const endS = Math.floor(nowS / SLOT_S) * SLOT_S;
    const yesterday = shiftDate(localDate(nowS, tz), -1);
    if (status.lastFinalizedDay !== yesterday) {
      const r = await syncWindow(localMidnightS(yesterday, tz), localMidnightS(shiftDate(yesterday, 1), tz));
      if (r.ok) status.lastFinalizedDay = yesterday;
    }
    const r = await syncWindow(endS - 3 * 3600, endS);
    if (r.ok) { status.lastSyncAt = new Date(now()).toISOString(); status.lastError = null; }
    else { status.lastError = r.error; pushLog('pv_strings_sync_error', { error: r.error }); }
    return r;
  }

  /**
   * Nachladen, rueckwaerts Tag fuer Tag (Anlagen-Zeitzone) bis `days`. Jede
   * Quellenart hoert fuer sich auf, sobald sie drei Tage in Folge nichts
   * liefert (Beginn ihrer Aufzeichnung): VRM reicht bei prod ~6 Monate, der
   * Fronius ~14. VRM drosselt, daher 1,5 s Pause nach jedem VRM-Tag.
   * Ein Fehler (Netzaussetzer, VRM kurz weg) bricht nicht sofort ab: der Tag
   * wird bis zu viermal mit wachsender Pause wiederholt — Schreiben ist ein
   * Upsert, Wiederholen also harmlos.
   */
  async function backfill({ days } = {}) {
    if (status.backfill.running) return { ok: false, error: 'laeuft bereits' };
    const cfg = getCfg();
    const tz = tzOf(cfg);
    const total = Math.max(1, Math.min(730, Number(days) || Number(cfg?.pvStrings?.backfillDays) || 730));
    Object.assign(status.backfill, { running: true, doneDays: 0, totalDays: total, startedAt: new Date(now()).toISOString(), finishedAt: null, error: null });
    pushLog('pv_strings_backfill_start', { days: total });
    const sources = resolvePvStringSources(cfg);
    const kinds = new Set();
    if (sources.some((s) => s.kind === 'victron_vrm_tracker')) kinds.add('vrm');
    if (sources.some((s) => s.kind === 'fronius_mppt')) kinds.add('fronius');
    const emptyRun = { vrm: 0, fronius: 0 };
    const skip = new Set();
    try {
      const nowS = Math.floor(now() / 1000);
      const today = localDate(nowS, tz);
      const endToday = Math.floor(nowS / SLOT_S) * SLOT_S;
      for (let d = 0; d < total; d += 1) {
        const date = shiftDate(today, -d);
        const startS = localMidnightS(date, tz);
        const endS = d === 0 ? endToday : localMidnightS(shiftDate(date, 1), tz);
        let r = await syncWindow(startS, endS, { skip });
        for (let attempt = 0; !r.ok && attempt < RETRY_DELAYS_MS.length; attempt += 1) {
          const limited = r.bySource.vrm && !r.bySource.vrm.ok && r.bySource.vrm.status === 429;
          pushLog('pv_strings_backfill_retry', { date, attempt: attempt + 1, error: r.error });
          await sleep(limited ? Math.max(30_000, RETRY_DELAYS_MS[attempt]) : RETRY_DELAYS_MS[attempt]);
          r = await syncWindow(startS, endS, { skip });
        }
        if (!r.ok) throw new Error(`${date}: ${r.error}`);
        status.backfill.doneDays = d + 1;
        for (const k of kinds) {
          if (skip.has(k)) continue;
          emptyRun[k] = r.bySource[k]?.points === 0 ? emptyRun[k] + 1 : 0;
          if (emptyRun[k] >= 3) skip.add(k);
        }
        if (kinds.size && [...kinds].every((k) => skip.has(k))) break;
        if (r.bySource.vrm) await sleep(1500);
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

  function allSeries(cfg) {
    const sources = resolvePvStringSources(cfg);
    return [...sources, ...resolvePvStringGroups(cfg, sources)];
  }

  /** Gespeicherte 5-Minuten-Werte eines Strings oder einer Gruppe. */
  async function readSeries(id, { start, end }) {
    const source = allSeries(getCfg()).find((s) => s.id === id);
    if (!source) return null;
    const rows = (await store()?.querySeries?.({ seriesKeys: [source.seriesKey], start, end, maxResolution: SLOT_S }) || [])
      .filter((r) => Number(r.resolution) === SLOT_S);
    return { source, rows };
  }

  /** Uebersicht: je String/Gruppe Abdeckung und Tagesertraege der letzten 14 Tage. */
  async function overview({ days = 14 } = {}) {
    const cfg = getCfg();
    const tz = tzOf(cfg);
    const endMs = now();
    const out = [];
    for (const s of allSeries(cfg)) {
      const all = (await store()?.querySeries?.({ seriesKeys: [s.seriesKey], start: new Date(endMs - 800 * DAY_S * 1000).toISOString(), end: new Date(endMs).toISOString(), maxResolution: SLOT_S }) || [])
        .filter((r) => Number(r.resolution) === SLOT_S);
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
        coverageDays: Math.round(all.length / (DAY_S / SLOT_S)),
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
    // Viertelstuendlich; VRM braucht etwas, der Fronius schreibt alle 5 min.
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

  async function discoverFronius(host) {
    return discoverFroniusMppts({ host, fetchImpl });
  }

  return { start, stop, syncRecent, syncWindow, backfill, readSeries, overview, discover, discoverFronius, getStatus };
}
