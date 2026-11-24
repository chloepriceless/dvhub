// services/storage-guard.js — Platz-Wache für kleine Speicher (eMMC/SD).
//
// Christin 2026-10-01: Boards mit 2–3 GB eMMC. Die 5-s-Rohwerte sind der
// größte Posten der Datenbank. Statt die Box vollaufen zu lassen, reagiert
// DVhub in Stufen — die 15-min-Werte (energy_slots_15m), Tagesaggregate und
// seltenen Ereignisse bleiben IMMER, ebenso die letzten 30 Tage Rohwerte:
//
//   < 20 % frei  „knapp“    ältere Rohwert-Blöcke sofort komprimieren
//   < 10 % frei  „wenig“    zusätzlich Rohwerte älter als N Tage entfernen,
//                           N in Stufen 365 → 180 → 90 → 30 (eine Stufe je Lauf)
//   <  5 % frei  „kritisch“ wie „wenig“, Warnung dringend
//
// Rohwerte werden nur entfernt, wo es 15-min-Werte dafür gibt (nie jüngere
// als der letzte verdichtete Zeitraum) — und nur die 5-s-Live-Werte: Preise
// (Erlösrechnung der History) und importierte Altdaten bleiben. Jede Stufe erscheint als Systemhinweis
// mit dem Vorschlag, den Speicher zu erweitern (USB-Stick/SD-Karte).

// 23.11.2026 (Kundenfall 12-GB-Platte, Christin S12/S13): Auf der
// Apache-Edition warf compress_chunk und brach den ganzen Lauf ab — die Wache
// löschte nichts und setzte keinen Hinweis, genau die Box ohne Kompression
// blieb still. Jetzt: Kompression nur versuchen, wo sie eingeschaltet ist, und
// Fehler einzeln abfangen; Löschstufe und Hinweise laufen immer. Fehlt die
// Kompression (keine TimescaleDB, Apache, ausgeschaltet, Job scheitert),
// erscheint unabhängig vom Platz ein eigener roter Hinweis „Datenbank ohne
// Kompression“ und ein Eintrag fürs Installateur-Portal
// (storage_compression_failed, läuft über den Fehlerweg des Audit-Logs).
import fs from 'node:fs';
import path from 'node:path';
import {
  mountCandidates, measureMounts, mountFor, readSamples, writeSamples, recordSample,
  growthMbPerDay, reserveMb, daysLeft as reachDays, DEFAULT_DB_VOLUME_DIR,
} from './storage-mounts.js';
import {
  PROFILES, profileForSize, profileRank, storageStage, stageRank, decideProfile, chooseProfile, cappedReserveMb,
  NO_COMPRESSION_MIN_PROFILE, NO_COMPRESSION_TIER1M_KEEP_DAYS,
  readProfileState, writeProfileState, startupProfile,
} from './storage-profile.js';
import { rawCompactedUntil, rawPruneCutoff, oldestLiveRawDays, pruneRawBefore } from './raw-retention.js';
import { pruneOneMinuteTier } from './telemetry-tiers.js';

export const STORAGE_CHECK_INTERVAL_MS = 30 * 60_000;
export const RAW_KEEP_STEPS_DAYS = Object.freeze([365, 180, 90, 30]);
/** Systemhinweis „Datenbank ohne Kompression“ (rot). */
export const COMPRESSION_WARNING_ID = 'db_compression';
// Solange die Kompression fehlt: Portal-Eintrag bei jeder Änderung und sonst einmal am Tag.
const COMPRESSION_REPORT_EVERY_MS = 24 * 3600_000;
// Erste Kompressions-Prüfung kurz nach dem Start (nur lesend, ohne Löschen).
const COMPRESSION_FIRST_CHECK_MS = 60_000;
const RETUNE_EVERY_MS = 3600_000;

export function storageLevel(freePct) {
  if (!Number.isFinite(freePct)) return 'unbekannt';
  if (freePct < 5) return 'kritisch';
  if (freePct < 10) return 'wenig';
  if (freePct < 20) return 'knapp';
  return 'ok';
}

/** Nächste Aufbewahrungsstufe: die erste, die kürzer ist als das, was heute da ist. */
export function nextKeepDays(oldestRawAgeDays) {
  for (const d of RAW_KEEP_STEPS_DAYS) if (oldestRawAgeDays > d) return d;
  return null;   // schon bei ≤ 30 Tagen — nichts mehr entfernen
}

// Gründe, bei denen gar nicht komprimiert werden KANN (E3 b) — nur dauerhafte.
// Nicht dabei: „ausgeschaltet“ (tuneTimescale schaltet sie selbst ein, Codex
// f90b8e04), keine/pausierte Regel, scheiternder Job, gescheitertes compress_chunk.
export const NO_COMPRESSION_REASONS = new Set(['no_timescaledb', 'apache', 'no_hypertable']);

const REASON_TEXT = Object.freeze({
  no_timescaledb: 'TimescaleDB ist nicht installiert',
  apache: 'TimescaleDB läuft in der Apache-Edition, die keine Kompression kann',
  no_hypertable: 'die Messwert-Tabelle ist nicht für TimescaleDB eingerichtet',
  not_enabled: 'die Kompression ist für die Messwerte ausgeschaltet',
  no_policy: 'die automatische Kompression ist nicht eingerichtet oder pausiert',
  job_failing: 'die automatische Kompression scheitert seit mehreren Tagen',
  compress_failed: 'das Komprimieren ist gescheitert',
  tuning_error: 'die Kompression ließ sich nicht einrichten',
});

/**
 * Kompression der Messwerte (timeseries_samples) prüfen, nur lesend.
 * reason null = alles in Ordnung. usable = compress_chunk ist möglich
 * (Community-Edition, Kompression auf der Hypertable eingeschaltet).
 * timescale = Erweiterung vorhanden (drop_chunks geht auch unter Apache,
 * am Image timescale/timescaledb:2.30.2-pg17 mit license=apache geprüft).
 */
export async function probeCompression(query) {
  const ext = (await query("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'")).rows?.length > 0;
  if (!ext) return { timescale: false, edition: null, usable: false, reason: 'no_timescaledb' };
  const edition = (await query("SELECT current_setting('timescaledb.license', true) AS lic")).rows?.[0]?.lic || null;
  if (edition !== 'timescale') return { timescale: true, edition, usable: false, reason: 'apache' };
  const h = (await query(`SELECT h.compression_enabled AS on,
      (SELECT count(*) FROM timescaledb_information.jobs j
        WHERE j.proc_name = 'policy_compression' AND j.hypertable_name = 'timeseries_samples' AND j.scheduled) AS policies,
      (SELECT bool_or(s.last_run_status = 'Failed'
                      AND (s.last_successful_finish IS NULL OR s.last_successful_finish < now() - INTERVAL '3 days'))
         FROM timescaledb_information.job_stats s JOIN timescaledb_information.jobs j USING (job_id)
        WHERE j.proc_name = 'policy_compression' AND j.hypertable_name = 'timeseries_samples' AND j.scheduled) AS failing
    FROM timescaledb_information.hypertables h WHERE h.hypertable_name = 'timeseries_samples'`)).rows?.[0];
  if (!h) return { timescale: true, edition, usable: false, reason: 'no_hypertable' };
  if (h.on !== true) return { timescale: true, edition, usable: false, reason: 'not_enabled' };
  if (!(Number(h.policies) > 0)) return { timescale: true, edition, usable: true, reason: 'no_policy' };
  if (h.failing === true) return { timescale: true, edition, usable: true, reason: 'job_failing' };
  return { timescale: true, edition, usable: true, reason: null };
}

/**
 * Grund aus dem Ergebnis von tuneTimescale (db-tuning.js). server.js legt es in
 * state.timescaleTuning ab, einen Fehler als { error }. null = nichts gemeldet.
 */
export function tuningCompressionIssue(tuning) {
  if (!tuning || typeof tuning !== 'object') return null;
  if (tuning.error) return { reason: 'tuning_error', detail: String(tuning.error).slice(0, 200) };
  if (tuning.skipped === 'apache') return { reason: 'apache', detail: null };
  if (tuning.skipped === 'no_timescaledb') return { reason: 'no_timescaledb', detail: null };
  if (tuning.skipped === 'no_hypertable') return { reason: 'no_hypertable', detail: null };
  if (tuning.deferred) return { reason: 'not_enabled', detail: 'wird beim nächsten Neustart eingeschaltet' };
  return null;
}

/**
 * Ergebnis der letzten Umstellung auf die Community-Edition aus
 * timescale-status.json (nativ, timescale-provision.sh → pkg-maintain.sh):
 * { at, result: 'ok' | 'failed' | 'apache', error }. Ohne Datei null (Docker).
 */
export function readProvisionStatus(dataDir, readFile = fs.readFileSync) {
  if (!dataDir) return null;
  try {
    const j = JSON.parse(readFile(path.join(dataDir, 'timescale-status.json'), 'utf8'));
    return j && typeof j.provision === 'object' && j.provision ? j.provision : null;
  } catch { return null; }
}

function fmtDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : null;
}

const ROLE_LABEL = { db: 'Datenbank-Platte', data: 'DVhub-Ordner', system: 'Systemplatte (/)', logs: 'Protokoll-Platte (/var/log)' };
function mountLabel(m) {
  return m.roles.map((r) => ROLE_LABEL[r] || r).join(' + ');
}

/** Text des roten Hinweises, verständlich für Kunden. */
export function compressionWarningText({ reason, detail = null, provision = null, container = false } = {}) {
  let s = `Datenbank ohne Kompression: ${REASON_TEXT[reason] || 'die Messwerte werden nicht komprimiert'}`
    + `${detail ? ` (${detail})` : ''}. `
    + 'Die Datenbank wächst dadurch um etwa 110–230 MB pro Tag statt um wenige MB '
    + 'und kann eine kleine Festplatte in wenigen Wochen füllen. ';
  if (!container) {
    s += 'DVhub versucht bei jedem Update und Neustart automatisch, auf die TimescaleDB-Community-Edition umzustellen. ';
    if (provision && (provision.result === 'failed' || provision.result === 'apache')) {
      const day = fmtDay(provision.at);
      s += `Der letzte Versuch${day ? ` am ${day}` : ''} ist gescheitert`
        + `${provision.error ? `: ${String(provision.error).slice(0, 200)}` : ''}. `;
    }
    s += 'Bleibt dieser Hinweis nach dem nächsten Update stehen, bitte den DVhub-Support kontaktieren.';
  } else {
    s += 'Bitte den DVhub-Support kontaktieren.';
  }
  return s;
}

export function createStorageGuard({
  getDb, getDataDir, pushLog, setWarning, now = () => Date.now(), statfs = (p) => fs.statfsSync(p),
  getTuning = () => null, isContainer = () => false, readFile = fs.readFileSync,
  // Schritt 2 (Konzept 23.11.): mehrere Datenträger + Wachstum.
  getPgDataDir = async () => null, stat = (p) => fs.statSync(p), exists = fs.existsSync,
  dbVolumeDir = DEFAULT_DB_VOLUME_DIR, samplesIo = {},
  // Schritt 3: Speicherprofil. onProfileChange(profile, info) stellt DB-Regeln um
  // (server.js: tuneTimescale, WAL); onStageChange(neu, alt, status) für Meldungen.
  initialProfile = null, onProfileChange = null, onStageChange = null, profileIo = {},
  // Schritt 4 (S11 a): Push ab „wenig“ (server.js: ctx.notifyDirect).
  notify = null,
} = {}) {
  let last = null;
  let running = false;
  let lastGuardErr = null; // Fehler-Drosselung: gleiche Meldung nicht in jedem Zyklus (TimescaleDB-Apache-Rauschen)
  let compression = { reason: null, detail: null, reportedAt: 0, edition: null, checkedAt: null };
  // Letztes compress_chunk gescheitert (bis zum nächsten Erfolg): sonst nähme die
  // nächste Probe („eingeschaltet“) den Hinweis weg und er käme alle 30 min neu.
  let compressFail = null;
  const log = (e, d, lvl) => { try { pushLog?.(e, d, lvl); } catch { /* egal */ } };
  const warn = (id, msg, severity) => { try { setWarning?.(id, msg, severity); } catch { /* egal */ } };

  // Gleicher Fehler nicht in jedem Zyklus: nur bei Änderung oder höchstens einmal je Stunde.
  function logGuardError(e) {
    const msg = e?.message || String(e);
    const n = now();
    if (msg !== lastGuardErr?.msg || n - (lastGuardErr?.at || 0) > 3600_000) {
      log('storage_guard_error', { error: msg }, 'warn');
      lastGuardErr = { msg, at: n };
    }
  }

  // Stand für API/Einstellungen; label = kurzer Grund (Karte „Datenbank-Engine“).
  const compressionView = () => ({
    ok: !compression.reason, reason: compression.reason, label: compression.reason ? (REASON_TEXT[compression.reason] || null) : null,
    detail: compression.detail, edition: compression.edition, checkedAt: compression.checkedAt,
  });

  /** Hinweis + Portal-Eintrag für die Kompression setzen bzw. wegnehmen. */
  function applyCompressionIssue(issue, edition) {
    const n = now();
    if (!issue) {
      if (compression.reason) log('storage_compression_ok', { edition }, 'info');
      compression = { reason: null, detail: null, reportedAt: 0, edition, checkedAt: new Date(n).toISOString() };
      warn(COMPRESSION_WARNING_ID, null);
      return;
    }
    const provision = isContainer?.() ? null : readProvisionStatus(getDataDir?.(), readFile);
    warn(COMPRESSION_WARNING_ID, compressionWarningText({ ...issue, provision, container: !!isContainer?.() }), 'error');
    let reportedAt = compression.reportedAt;
    if (issue.reason !== compression.reason || n - reportedAt > COMPRESSION_REPORT_EVERY_MS) {
      // …_failed → Fehlerweg ans Installateur-Portal (log-retention.js AUDIT_ERROR_SQL).
      log('storage_compression_failed', {
        reason: issue.reason, detail: issue.detail || null, edition,
        provision: provision ? { result: provision.result || null, at: provision.at || null, error: provision.error || null } : null,
      }, 'error');
      reportedAt = n;
    }
    compression = { reason: issue.reason, detail: issue.detail || null, reportedAt, edition, checkedAt: new Date(n).toISOString() };
  }

  /**
   * Kompression prüfen und den Hinweis danach setzen. Ergebnis der Probe, oder
   * null, wenn sie nicht möglich war (dann bleibt der bisherige Hinweis; nur
   * wenn tuneTimescale selbst etwas gemeldet hat, gilt dessen Grund).
   */
  async function evaluateCompression(db) {
    const tuning = tuningCompressionIssue(getTuning?.());
    let probe;
    try {
      probe = await probeCompression((q, p) => db.query(q, p));
    } catch (e) {
      logGuardError(e);
      if (tuning) applyCompressionIssue(tuning, compression.edition);
      return null;
    }
    const issue = probe.reason ? { reason: probe.reason, detail: null }
      : (compressFail ? { reason: 'compress_failed', detail: compressFail.detail } : null);
    // Den Fehlertext von tuneTimescale mitgeben, wenn die Probe die Lücke bestätigt.
    if (issue && tuning?.detail) issue.detail = tuning.detail;
    applyCompressionIssue(issue, probe.edition);
    return probe;
  }

  async function checkCompression() {
    if (running) return compression;
    const db = getDb?.();
    if (!db || typeof db.query !== 'function') return compression;
    running = true;
    try { await evaluateCompression(db); } finally { running = false; }
    return compression;
  }

  // ── Speicherprofil (Schritt 3) ─────────────────────────────────────────────
  let profileState = null;          // gespeicherter Stand (storage-profile.json)
  let profileInfo = null;           // letzte Entscheidung
  let lastEffective = initialProfile || startupProfile(getDataDir?.(), readFile).name;
  let retentionDay = null;          // Profil-Aufbewahrung höchstens einmal am Tag
  let retuneAt = -Infinity;         // letzter Neuversuch der Kompressions-Einrichtung

  // E3 b (Christin 24.11.2026): ohne Kompression gilt mindestens „winzig“ —
  // nur für die Wirkung, das gespeicherte Profil bleibt (kommt die Kompression
  // zurück, gilt es wieder).
  const noCompression = () => NO_COMPRESSION_REASONS.has(compression.reason);
  function withCompressionFloor(dec) {
    if (!noCompression() || profileRank(dec.effective) >= profileRank(NO_COMPRESSION_MIN_PROFILE)) return dec;
    return {
      ...dec, effective: NO_COMPRESSION_MIN_PROFILE, temporary: true,
      reason: `Datenbank ohne Kompression: mindestens „${PROFILES[NO_COMPRESSION_MIN_PROFILE].label}“, solange nicht komprimiert wird`,
    };
  }

  async function decide(db, { totalMb, level, dataDir }) {
    const sizeProfile = profileForSize(totalMb);
    const before = profileState || readProfileState(dataDir, readFile);
    let fresh = false;
    if (!before) {
      // Neuinstallation: noch keine bzw. erst seit < 2 Tagen Messwerte (S2 a).
      const d = await oldestLiveRawDays((q, p) => db.query(q, p));
      fresh = d == null || d < 2;
    }
    const nowIso = new Date(now()).toISOString();
    const dec = withCompressionFloor(decideProfile({ state: before, sizeProfile, stage: level, fresh, nowIso }));
    const { effective: _e, effectiveAt: _a, ...beforeCore } = before || {};
    void _e; void _a;
    const stateChanged = JSON.stringify(dec.state) !== JSON.stringify(beforeCore);
    profileState = dec.state;
    profileInfo = { ...dec, sizeProfile };
    if (stateChanged || dec.effective !== lastEffective || !before) {
      writeProfileState(dataDir, { ...dec.state, effective: dec.effective, effectiveAt: nowIso }, profileIo);
    }
    const switched = dec.effective !== lastEffective;
    if (switched) {
      log('storage_profile', { from: lastEffective, to: dec.effective, base: dec.base, temporary: dec.temporary, reason: dec.reason }, 'warn');
      const prevName = lastEffective;
      lastEffective = dec.effective;
      try { await onProfileChange?.(PROFILES[dec.effective], { from: prevName, ...profileView() }); } catch (e) { logGuardError(e); }
    }
    return switched;
  }

  function profileView() {
    if (!profileInfo) return { effective: lastEffective, base: null, mode: null, suggested: null, temporary: false, reason: null, sizeProfile: null, values: PROFILES[lastEffective] || null };
    return {
      effective: profileInfo.effective, base: profileInfo.base, mode: profileInfo.state.mode, origin: profileInfo.state.origin,
      suggested: profileInfo.suggested, temporary: profileInfo.temporary, reason: profileInfo.reason,
      sizeProfile: profileInfo.sizeProfile,
      // Werte, die wirklich gelten (ohne Kompression: 1-min nur 90 Tage, E3 b/D1 a).
      values: { ...PROFILES[profileInfo.effective], ...(noCompression() ? { tier1mKeepDays: NO_COMPRESSION_TIER1M_KEEP_DAYS } : {}) },
      ...(profileInfo.pending ? { pending: true } : {}),
    };
  }

  // Lauf anfordern: läuft gerade einer, danach sicher noch einmal (Codex 246e360a).
  let recheck = false;
  function requestCheck() {
    if (running) { recheck = true; return; }
    check().catch(() => {});
  }

  /**
   * Profilwahl per Klick (S2 a): 'auto' oder ein Profilname. Gespeichert und
   * sofort im Status sichtbar; umgesetzt (DB-Regeln, Aufbewahrung) vom nächsten
   * Lauf, der gleich im Hintergrund startet — nie im Befehlskanal des Workers.
   */
  function chooseProfileClick(choice) {
    const sizeProfile = profileInfo?.sizeProfile || profileForSize(last?.totalMb);
    const dataDir = getDataDir?.() || null;
    const base = profileState || readProfileState(dataDir, readFile);
    const { effective: _e, effectiveAt: _a, ...core } = base || {};
    void _e; void _a;
    const st = chooseProfile(base ? core : null, choice, { sizeProfile, nowIso: new Date(now()).toISOString() });
    profileState = st;
    writeProfileState(dataDir, { ...st, effective: lastEffective, effectiveAt: null }, profileIo);
    log('storage_profile_chosen', { choice, base: st.base, mode: st.mode }, 'info');
    // Sofort im Status (und damit im Worker-Schnappschuss) zeigen.
    const dec = withCompressionFloor(decideProfile({ state: st, sizeProfile, stage: last?.level || 'ok', nowIso: new Date(now()).toISOString() }));
    profileInfo = { ...dec, sizeProfile, pending: dec.effective !== lastEffective };
    if (last) last = { ...last, profile: profileView() };
    requestCheck();
    return st;
  }

  async function check() {
    if (running) return last;
    running = true;
    try {
      // Alle betroffenen Datenträger; maßgeblich für Maßnahmen ist die Platte
      // der Datenbank (nur dort hilft Komprimieren/Löschen).
      const container = !!isContainer?.();
      const dataDir = getDataDir?.() || null;
      let pgDataDir = null;
      if (!container) { try { pgDataDir = await getPgDataDir?.(); } catch { /* egal */ } }
      const mounts = measureMounts(
        mountCandidates({ container, dataDir: dataDir || '/', pgDataDir, dbVolumeDir, exists }),
        { statfs, stat });
      // DB-Platte bekannt (nativ: data_directory), aber nicht messbar: nie eine
      // andere Platte an ihre Stelle setzen und nichts in der DB aufräumen
      // (Codex bec0a2c7, P1). Ohne bekanntes Datenverzeichnis wie bisher der DVhub-Ordner.
      const dbUnmeasured = !container && !!pgDataDir && !mountFor(mounts, 'db');
      const primary = dbUnmeasured ? null : (mountFor(mounts, 'db') || mountFor(mounts, 'data') || mounts[0] || null);
      const dir = primary?.paths?.[0] || pgDataDir || dataDir || '/';
      const freeMb = primary ? primary.freeMb : null;
      const totalMb = primary ? primary.totalMb : null;
      const freePct = primary && Number.isFinite(primary.freePct) ? primary.freePct : NaN;
      const db = getDb?.();
      const hasDb = !!(db && typeof db.query === 'function');
      const out = {
        at: new Date(now()).toISOString(), dir, freePct, freeMb, totalMb, level: 'unbekannt', dbMb: null, actions: [], compression: null,
        mounts: mounts.map((m) => ({ ...m, level: storageStage({ freeMb: m.freeMb, totalMb: m.totalMb }) })),
        growthMbPerDay: null, daysLeft: null, reserveMb: null, profile: null,
        ...(dbUnmeasured ? { dbUnmeasured: true } : {}),
      };
      if (hasDb) {
        try { out.dbMb = Math.round(Number((await db.query('SELECT pg_database_size(current_database()) AS b')).rows?.[0]?.b) / 1048576); } catch { /* egal */ }
      }
      // Wachstum: ein Messpunkt je Tag (Datei im Datenverzeichnis), Reichweite der DB-Platte.
      const day = new Date(now()).toISOString().slice(0, 10);
      try {
        let samples = readSamples(dataDir, samplesIo.readFile || readFile);
        if (dataDir && mounts.length && samples[samples.length - 1]?.day !== day) {
          samples = recordSample(samples, { day, mounts, dbMb: out.dbMb });
          writeSamples(dataDir, samples, samplesIo);
        }
        const role = mountFor(mounts, 'db') ? 'db' : 'data';
        out.growthMbPerDay = growthMbPerDay(samples, role);
      } catch { /* Wachstum ist Zugabe */ }
      // Reserve nach dem GESPEICHERTEN Profil, nicht dem vorübergehend härteren —
      // sonst schaukelt die Stufe zwischen zwei Läufen hin und her (Codex 2ef7ff2c).
      const baseName = profileState?.base || profileInfo?.base || lastEffective;
      out.reserveMb = cappedReserveMb(reserveMb({ container, maxWalMb: PROFILES[baseName]?.maxWalMb ?? 1024 }), totalMb);
      out.daysLeft = reachDays({ freeMb, reserveMb: out.reserveMb, growth: out.growthMbPerDay });
      // Stufe: Reichweite, sonst feste Schwellen; Hysterese gegen die vorige Stufe.
      const level = storageStage({
        freeMb, totalMb, daysLeft: out.daysLeft, reserveMb: out.reserveMb,
        growthKnown: out.growthMbPerDay != null, prev: last?.level || 'ok',
      });
      out.level = level;
      // Genug Platz: die Wache komprimiert nicht selbst, das macht der Job. Ein
      // früheres Scheitern von compress_chunk gilt dann nicht mehr — sonst bliebe
      // der rote Hinweis bis zum Neustart stehen (Codex 949b20f2).
      // Nur bei GEMESSEN genug Platz — „unbekannt“ (statfs ging nicht) belegt nichts (Codex 837ea5fd).
      if (level === 'ok' && compressFail) compressFail = null;
      let probe = null;
      try {
        if (hasDb) {
          probe = await evaluateCompression(db);
          // Kompression nur ausgeschaltet (z. B. Sperre beim Start, compression_lock_timeout):
          // Einrichtung höchstens stündlich erneut anstoßen — ohne Profilwechsel und
          // ohne Folgen für die Aufbewahrung (Codex 5ea1b282).
          if (compression.reason === 'not_enabled' && onProfileChange && now() - retuneAt >= RETUNE_EVERY_MS) {
            retuneAt = now();
            try {
              await onProfileChange(PROFILES[lastEffective], { from: lastEffective, retune: true, ...profileView() });
              probe = (await evaluateCompression(db)) || probe;
            } catch (e) { logGuardError(e); }
          }
          // Ohne Probe (Fehler) wie früher an der Erweiterung festmachen.
          const ts = probe ? probe.timescale
            : (await db.query("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'")).rows?.length > 0;
          if (!dbUnmeasured) {
            try {
              // Nach einem Profilwechsel (DB-Regeln neu eingestellt, z. B. Kompression
              // eingeschaltet) erst neu prüfen und neu entscheiden — sonst löscht die
              // Aufbewahrung nach einem Stand, der schon nicht mehr gilt (Codex f90b8e04).
              if (await decide(db, { totalMb, level, dataDir })) {
                probe = (await evaluateCompression(db)) || probe;
                await decide(db, { totalMb, level, dataDir });
              }
            } catch (e) { logGuardError(e); }
          }
          if (level !== 'ok' && level !== 'unbekannt') {
            // Komprimieren nur, wo es geht (Community + eingeschaltet); ein Fehler
            // hält Löschstufe und Hinweis nicht mehr auf (Apache: compress_chunk wirft).
            if (ts && (probe ? probe.usable : true)) {
              try {
                const r = await db.query(`SELECT count(*) AS n FROM (SELECT compress_chunk(c, if_not_compressed => true)
                  FROM show_chunks('timeseries_samples', older_than => INTERVAL '1 day') c) x`);
                out.actions.push({ action: 'compress', chunks: Number(r.rows?.[0]?.n) || 0 });
                if (compressFail) {
                  compressFail = null;
                  if (compression.reason === 'compress_failed') applyCompressionIssue(null, probe?.edition ?? null);
                }
              } catch (e) {
                const msg = String(e?.message || e).slice(0, 200);
                out.actions.push({ action: 'compress', error: msg });
                logGuardError(e);
                compressFail = { detail: msg };
                if (!compression.reason || compression.reason === 'compress_failed') {
                  applyCompressionIssue({ reason: 'compress_failed', detail: msg }, probe?.edition ?? null);
                }
              }
            }
          }
          // Aufbewahrung der 5-s-Rohwerte nach Profil (S4), höchstens einmal am Tag.
          const eff = PROFILES[lastEffective];
          // 1-min-Stufe (D1 a): klein 365, winzig 180 Tage, ohne Kompression 90; 15-min für immer.
          const tier1mKeep = noCompression() ? NO_COMPRESSION_TIER1M_KEEP_DAYS : (eff?.tier1mKeepDays ?? null);
          // Nicht bei nicht messbarer DB-Platte: dann räumt DVhub in der DB nichts auf (Codex 33062ac7).
          if ((eff?.rawKeepDays || tier1mKeep) && retentionDay !== day && !dbUnmeasured) {
            retentionDay = day;
            if (eff?.rawKeepDays) {
              try { await profileRetention(db, ts, eff, out); } catch (e) {
                out.actions.push({ action: 'retain_raw', error: String(e?.message || e).slice(0, 200) });
                logGuardError(e);
              }
            }
            if (tier1mKeep) {
              try {
                const r = await pruneOneMinuteTier(db, { olderThan: new Date(now() - tier1mKeep * 86_400_000).toISOString() });
                if (r.cutoff && (r.droppedChunks || r.deletedRows)) {
                  out.actions.push({ action: 'retain_1m', keepDays: tier1mKeep, before: r.cutoff, droppedChunks: r.droppedChunks, deletedRows: r.deletedRows });
                  log('storage_tier1m_retention', { keepDays: tier1mKeep, before: r.cutoff }, 'info');
                }
              } catch (e) {
                out.actions.push({ action: 'retain_1m', error: String(e?.message || e).slice(0, 200) });
                logGuardError(e);
              }
            }
          }
          // Notfall „kritisch“: wie bisher Rohwerte stufenweise (365 → 180 → 90 → 30 Tage).
          if (level === 'kritisch') {
            try { await dropRaw(db, ts, out, freePct); } catch (e) {
              out.actions.push({ action: 'drop_raw', error: String(e?.message || e).slice(0, 200) });
              logGuardError(e);
            }
          }
        }
      } catch (e) {
        logGuardError(e);
      }
      out.compression = compressionView();
      out.profile = profileView();
      // Aufteilung der Datenbank für die Karte „Speicher“ (lesend, Fehler egal).
      if (hasDb && !dbUnmeasured) { try { out.db = await dbBreakdown((q, p) => db.query(q, p), probe); } catch { /* egal */ } }
      // Andere Platten (System, DVhub-Ordner, Logs): nur Hinweis, DVhub kann dort nichts freigeben.
      const others = out.mounts.filter((m) => m.key !== primary?.key && (m.level === 'wenig' || m.level === 'kritisch'));
      warn('storage_other', others.length ? others.map((m) => `${mountLabel(m)} ${m.level}: ${m.freePct} % frei (${m.freeMb} MB)`).join('; ')
        + '. DVhub kann dort selbst nichts freigeben — Protokolle, alte Docker-Images oder andere Dateien prüfen.' : null,
        others.some((m) => m.level === 'kritisch') ? 'error' : 'warn');
      // Systemhinweis setzen bzw. wegnehmen — immer, auch wenn oben etwas scheiterte.
      if (dbUnmeasured) {
        warn('storage', `Datenbank-Platte nicht messbar (${pgDataDir}): DVhub räumt in der Datenbank nichts auf, bis sie wieder messbar ist.`, 'warn');
      } else if (level === 'ok' || level === 'unbekannt') warn('storage', null);
      else warn('storage', storageWarningText(out), level === 'kritisch' ? 'error' : 'warn');
      const prevLevel = last?.level || null;
      // Neuen Stand veröffentlichen, BEVOR Rückrufe ihn lesen (z. B. die Log-
      // Aufbewahrung über status().level, Codex 2ef7ff2c).
      last = out;
      if (level !== prevLevel) {
        log('storage_level', { level, freePct, freeMb, dbMb: out.dbMb, daysLeft: out.daysLeft }, level === 'ok' ? 'info' : 'warn');
        try { onStageChange?.(level, prevLevel, out); } catch { /* egal */ }
        // S11 a: ab „wenig“, einmal je Wechsel nach oben — Push und Installateur-Portal
        // (…_error läuft über den Fehlerweg des Audit-Logs ans Portal).
        if ((level === 'wenig' || level === 'kritisch') && stageRank(level) > stageRank(prevLevel || 'ok')) {
          const text = storageWarningText(out);
          log('storage_space_error', {
            level, freePct, freeMb, totalMb, daysLeft: out.daysLeft, growthMbPerDay: out.growthMbPerDay,
            profile: out.profile?.effective || null, compression: out.compression?.ok ?? null,
          }, level === 'kritisch' ? 'error' : 'warn');
          Promise.resolve(notify?.({
            event: 'storage_level', level: level === 'kritisch' ? 'critical' : 'warning',
            title: `DVhub: Speicher ${level}`, body: text,
          })).catch(() => {});
        }
      }
      return out;
    } catch (e) {
      logGuardError(e);
      return last;
    } finally {
      running = false;
      if (recheck) { recheck = false; setImmediate(() => { check().catch(() => {}); }); }
    }
  }

  function storageWarningText(out) {
    const dropped = out.actions.find((a) => a.action === 'drop_raw' && !a.error);
    const compresses = !compression.reason || compression.reason === 'no_policy' || compression.reason === 'job_failing';
    const p = out.profile;
    return `Speicher ${out.level}: ${out.freePct} % frei (${out.freeMb} MB)`
      + (Number.isFinite(out.daysLeft) ? `, voll in etwa ${Math.round(out.daysLeft)} Tagen` : '') + '. '
      + (dropped ? `5-s-Rohwerte älter als ${dropped.keepDays} Tage wurden entfernt — 15-min-Werte bleiben. `
        : (compresses ? 'Ältere Messwerte werden früher komprimiert. ' : 'Messwerte werden nicht komprimiert. '))
      + (p?.temporary ? `Speicherprofil vorübergehend „${PROFILES[p.effective].label}“. ` : '')
      // Ohne TimescaleDB (E2E „kleine Platte“ 24.11.): gelöschter Platz bleibt in der Datenbank.
      + (out.actions.some((a) => a.mode === 'delete' && !a.error)
        ? 'Ohne TimescaleDB nutzt die Datenbank den frei gewordenen Platz nur für neue Messwerte; an die Festplatte zurück gibt ihn erst eine Wartung (VACUUM FULL, sperrt die Datenbank kurz) — dafür bitte den Support kontaktieren. ' : '')
      + 'Speicher erweitern: USB-Stick oder SD-Karte als Datenspeicher einrichten.';
  }

  // Größen für die Karte „Speicher“ in MB: Messwerte (roh/komprimiert), 15-min,
  // Protokolle, Optimierer-Läufe, Rest.
  async function dbBreakdown(q, probe) {
    const mb = (b) => (Number.isFinite(Number(b)) ? Math.round(Number(b) / 1048576) : null);
    const out = { samplesMb: null, compressedChunks: null, chunks: null, rawBeforeMb: null, rawAfterMb: null, tables: {} };
    try {
      const r = await q(probe?.timescale && probe.reason !== 'no_hypertable'
        ? "SELECT hypertable_size('timeseries_samples') AS b"
        : "SELECT pg_total_relation_size('timeseries_samples') AS b");
      out.samplesMb = mb(r.rows?.[0]?.b);
    } catch { /* egal */ }
    if (probe?.timescale && probe.edition === 'timescale' && probe.reason !== 'no_hypertable' && probe.reason !== 'not_enabled') {
      try {
        const r = (await q(`SELECT count(*) FILTER (WHERE compression_status = 'Compressed') AS c, count(*) AS n,
            sum(before_compression_total_bytes) AS b, sum(after_compression_total_bytes) AS a
          FROM chunk_compression_stats('timeseries_samples')`)).rows?.[0] || {};
        out.compressedChunks = Number(r.c) || 0; out.chunks = Number(r.n) || 0;
        out.rawBeforeMb = mb(r.b); out.rawAfterMb = mb(r.a);
      } catch { /* egal */ }
    }
    try {
      const r = await q(`SELECT c.relname AS t, pg_total_relation_size(c.oid) AS b FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND c.relname IN ('energy_slots_15m', 'control_events', 'audit_log', 'optimizer_run_series', 'optimizer_runs')`);
      for (const row of r.rows || []) out.tables[row.t] = mb(row.b);
    } catch { /* egal */ }
    // Datenstufen (telemetry-tiers.js): mit TimescaleDB Hypertables → hypertable_size.
    for (const t of ['timeseries_samples_1m', 'timeseries_samples_15m']) {
      try {
        const r = await q(probe?.timescale
          ? `SELECT COALESCE(hypertable_size('${t}'), pg_total_relation_size('${t}')) AS b`
          : `SELECT pg_total_relation_size('${t}') AS b`);
        out.tables[t] = mb(r.rows?.[0]?.b);
      } catch { /* Tabelle fehlt (Migration 027 noch nicht gelaufen) */ }
    }
    return out;
  }

  // Profil-Aufbewahrung: 5-s-Live-Rohwerte älter als keepDays, nie jünger als der verdichtete Stand.
  async function profileRetention(db, ts, prof, out) {
    const q = (sql, p) => db.query(sql, p);
    const cutoff = rawPruneCutoff({ keepDays: prof.rawKeepDays, now: now(), compactedUntil: await rawCompactedUntil(q) });
    if (!cutoff) return;
    const oldest = await oldestLiveRawDays(q);
    if (oldest == null || now() - oldest * 86_400_000 >= cutoff.getTime()) return;   // nichts älter
    const r = await pruneRawBefore(db, { before: cutoff, timescale: ts });
    out.actions.push({ action: 'retain_raw', keepDays: prof.rawKeepDays, before: r.before, mode: r.mode, ...(r.mode === 'delete' ? { rows: r.rows, vacuumed: r.vacuumed } : {}) });
    log('storage_raw_retention', { profile: prof.name, keepDays: prof.rawKeepDays, before: r.before }, 'info');
  }

  // Notfall: eine Aufbewahrungsstufe der 5-s-Live-Rohwerte entfernen (kritisch).
  async function dropRaw(db, ts, out, freePct) {
    const q = (sql, p) => db.query(sql, p);
    const keep = nextKeepDays(await oldestLiveRawDays(q));
    if (!keep) return;
    const cutoff = rawPruneCutoff({ keepDays: keep, now: now(), compactedUntil: await rawCompactedUntil(q) });
    if (!cutoff) return;
    const r = await pruneRawBefore(db, { before: cutoff, timescale: ts });
    out.actions.push({ action: 'drop_raw', keepDays: keep, before: r.before, mode: r.mode, ...(r.mode === 'delete' ? { rows: r.rows, vacuumed: r.vacuumed } : {}) });
    log('storage_raw_dropped', { keepDays: keep, before: r.before, freePct }, 'warn');
  }

  let timer = null;
  return {
    start() {
      if (timer) return;
      setTimeout(() => { checkCompression().catch(() => {}); }, COMPRESSION_FIRST_CHECK_MS).unref?.();
      setTimeout(() => { check().catch(() => {}); }, 5 * 60_000).unref?.();
      timer = setInterval(() => { check().catch(() => {}); }, STORAGE_CHECK_INTERVAL_MS);
      timer.unref?.();
    },
    check,
    checkCompression,
    status: () => last,
    compressionStatus: () => compressionView(),
    profile: () => profileView(),
    chooseProfile: chooseProfileClick,
  };
}
