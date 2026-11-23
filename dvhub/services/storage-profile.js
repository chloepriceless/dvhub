// services/storage-profile.js — Speicherprofil und Speicher-Stufe (Speicher-
// Konzept 23.11.2026, Schritt 3). Reine Funktionen, keine Ein-/Ausgabe.
//
// Profil (statisch, aus der Größe der Platte mit den PostgreSQL-Daten; Christin
// S1: Grenzen 64/24/8 GB): groß / mittel / klein / winzig. Es stellt ein, wie
// früh komprimiert wird (S4: Kompression IMMER, auf allen Profilen — kleinere
// Blöcke, früher, öfter), wie lange 5-s-Rohwerte bleiben, max_wal_size, wie
// viele lokale Backups, die journald-Grenze (S8 a: nur klein/winzig).
//
// Stufe (dynamisch): Reichweite in Tagen (frei − Reserve, geteilt durch
// Wachstum); solange es keine 2 Tage Wachstum gibt, feste Schwellen aus Prozent
// und MB. Hysterese: eine Stufe fällt erst zurück, wenn ihre Schwelle um 25 %
// überschritten ist.
//
// Entscheidung S2 a: Neuinstallation → Profil automatisch. Bestandsbox → bleibt
// beim heutigen Verhalten („groß“), das passende Profil ist nur ein Vorschlag
// mit Klick. Bei „wenig“/„kritisch“ greift DVhub immer selbst ein: eine
// Profilstufe härter, solange die Stufe anhält. Automatisch nur härter, weicher
// nur per Klick.

import fs from 'node:fs';
import path from 'node:path';

export const PROFILE_ORDER = Object.freeze(['gross', 'mittel', 'klein', 'winzig']);
export const STAGE_ORDER = Object.freeze(['ok', 'knapp', 'wenig', 'kritisch']);

export const PROFILES = Object.freeze({
  gross: Object.freeze({
    // compressSchedule null: Lauf-Intervall von TimescaleDB unangetastet (Verhalten bis 1.0.12).
    name: 'gross', label: 'groß', chunkInterval: '1 day', compressAfter: '2 days', compressSchedule: null,
    rawKeepDays: null, maxWalMb: 1024, minWalMb: 64, backupKeepMax: 14, journaldMaxMb: null,
  }),
  mittel: Object.freeze({
    name: 'mittel', label: 'mittel', chunkInterval: '1 day', compressAfter: '1 day', compressSchedule: '6 hours',
    rawKeepDays: null, maxWalMb: 512, minWalMb: 64, backupKeepMax: 7, journaldMaxMb: null,
  }),
  klein: Object.freeze({
    name: 'klein', label: 'klein', chunkInterval: '12 hours', compressAfter: '12 hours', compressSchedule: '2 hours',
    rawKeepDays: 365, maxWalMb: 256, minWalMb: 64, backupKeepMax: 3, journaldMaxMb: 200,
  }),
  winzig: Object.freeze({
    name: 'winzig', label: 'winzig', chunkInterval: '6 hours', compressAfter: '6 hours', compressSchedule: '1 hour',
    rawKeepDays: 30, maxWalMb: 128, minWalMb: 32, backupKeepMax: 0, journaldMaxMb: 100,
  }),
});

// Grenzen 64/24/8 GB (Christin S1) als Herstellerangabe: eine „64-GB“-Karte hat
// nach Formatieren nur ~57 GiB. Darum 90 % der Herstellerangabe in MiB.
const nominal = (gb) => Math.floor((0.9 * gb * 1e9) / 1048576);
export const PROFILE_MIN_MB = Object.freeze({ gross: nominal(64), mittel: nominal(24), klein: nominal(8) });

const rank = (list, x) => { const i = list.indexOf(x); return i < 0 ? 0 : i; };
export const profileRank = (p) => rank(PROFILE_ORDER, p);
export const stageRank = (s) => rank(STAGE_ORDER, s);

/** Profil aus der Größe der Datenbank-Platte (MB). */
export function profileForSize(totalMb) {
  const t = Number(totalMb);
  if (!Number.isFinite(t) || t <= 0) return 'gross';
  if (t >= PROFILE_MIN_MB.gross) return 'gross';
  if (t >= PROFILE_MIN_MB.mittel) return 'mittel';
  if (t >= PROFILE_MIN_MB.klein) return 'klein';
  return 'winzig';
}

/** n Stufen härter, höchstens „winzig“. */
export function harderProfile(p, n = 1) {
  return PROFILE_ORDER[Math.min(PROFILE_ORDER.length - 1, profileRank(p) + n)];
}
export const harderOf = (a, b) => (profileRank(a) >= profileRank(b) ? a : b);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** Rückfall-Schwellen (freier Platz in MB), solange es kein Wachstum gibt. */
export function fallbackThresholds(totalMb) {
  const t = Math.max(0, Number(totalMb) || 0);
  return {
    knapp: clamp(0.20 * t, Math.min(1024, 0.30 * t), 10240),
    wenig: clamp(0.10 * t, Math.min(512, 0.15 * t), 5120),
    kritisch: clamp(0.05 * t, Math.min(256, 0.08 * t), 2048),
  };
}
export const REACH_DAYS = Object.freeze({ knapp: 180, wenig: 60, kritisch: 14 });

/**
 * Reserve für die Stufe, höchstens 8 % der Platte: Auf einer 2,3-GB-Platte
 * (EnergyLink) passt ein Docker-Update (~1,5 GB) ohnehin nicht — ohne Deckel
 * stünde die Box sonst immer auf „kritisch“. 8 % liegt unter der Schwelle für
 * „wenig“ (≥ 10 % bzw. 15 % kleiner Platten), so bleibt „wenig“ erreichbar.
 */
export function cappedReserveMb(reserveMb, totalMb) {
  return Math.round(Math.min(Math.max(0, Number(reserveMb) || 0), 0.08 * Math.max(0, Number(totalMb) || 0)));
}

function rawStage({ freeMb, totalMb, daysLeft, reserveMb, growthKnown }, f = 1) {
  if (!Number.isFinite(freeMb) || !(Number(totalMb) > 0)) return 'unbekannt';
  const fb = fallbackThresholds(totalMb);
  // Fester Boden: unter der kritischen MB-Schwelle bzw. unter der Reserve ist es
  // immer kritisch, auch wenn (noch) nichts wächst.
  if (freeMb < fb.kritisch * f || (reserveMb > 0 && freeMb < reserveMb * f)) return 'kritisch';
  if (growthKnown) {
    if (daysLeft == null) return 'ok';           // wächst nicht
    if (daysLeft < REACH_DAYS.kritisch * f) return 'kritisch';
    if (daysLeft < REACH_DAYS.wenig * f) return 'wenig';
    if (daysLeft < REACH_DAYS.knapp * f) return 'knapp';
    return 'ok';
  }
  if (freeMb < fb.wenig * f) return 'wenig';
  if (freeMb < fb.knapp * f) return 'knapp';
  return 'ok';
}

/**
 * Speicher-Stufe mit Hysterese. growthKnown: es gibt ≥ 2 Tage Wachstum
 * (daysLeft null heißt dann „wächst nicht“). prev: vorige Stufe. reserveMb
 * bereits gedeckelt (cappedReserveMb).
 */
export function storageStage({ freeMb, totalMb, daysLeft = null, reserveMb = 0, growthKnown = false, prev = 'ok' } = {}) {
  const now = rawStage({ freeMb, totalMb, daysLeft, reserveMb, growthKnown });
  if (now === 'unbekannt') return now;
  if (stageRank(now) >= stageRank(prev) || !STAGE_ORDER.includes(prev)) return now;
  // Besser geworden: erst zurück, wenn die Schwellen um 25 % überschritten sind.
  const relaxed = rawStage({ freeMb, totalMb, daysLeft, reserveMb, growthKnown }, 1.25);
  return STAGE_ORDER[Math.max(stageRank(now), Math.min(stageRank(prev), stageRank(relaxed)))];
}

/**
 * Profil entscheiden. state: gespeicherter Stand (storage-profile.json) oder
 * null beim ersten Lauf. fresh: Neuinstallation (keine bzw. erst seit < 2 Tagen
 * Messwerte). Rückgabe: neuer state plus effective (gilt jetzt), base, suggested.
 *   state = { version, mode: 'auto'|'fixed', base, origin: 'install'|'existing', decidedAt }
 */
export function decideProfile({ state = null, sizeProfile, stage = 'ok', fresh = false, nowIso = null } = {}) {
  let st = state && PROFILE_ORDER.includes(state.base) ? { ...state } : null;
  if (!st) {
    st = fresh
      ? { version: 1, mode: 'auto', base: sizeProfile, origin: 'install', decidedAt: nowIso }
      : { version: 1, mode: 'fixed', base: 'gross', origin: 'existing', decidedAt: nowIso };
  }
  let suggested = null;
  if (st.mode === 'auto') {
    // Automatisch nur härter (Platte kleiner geworden, Umzug); weicher nur als Vorschlag.
    if (profileRank(sizeProfile) > profileRank(st.base)) st = { ...st, base: sizeProfile, decidedAt: nowIso };
    else if (profileRank(sizeProfile) < profileRank(st.base)) suggested = sizeProfile;
  } else if (profileRank(sizeProfile) !== profileRank(st.base)) {
    suggested = sizeProfile;
  }
  const temp = stage === 'wenig' || stage === 'kritisch';
  const effective = temp ? harderProfile(st.base, 1) : st.base;
  let reason;
  if (temp) reason = `Speicher ${stage}: eine Stufe härter als „${PROFILES[st.base].label}“, solange der Platz knapp ist`;
  else if (st.mode === 'auto') reason = `automatisch aus der Größe der Datenbank-Platte (${st.origin === 'install' ? 'Neuinstallation' : 'übernommen'})`;
  else reason = st.origin === 'existing' && st.base === 'gross' ? 'bisheriges Verhalten (Bestandsbox)' : 'fest gewählt';
  return { state: st, base: st.base, effective, suggested, temporary: temp, reason };
}

/** Profilwahl per Klick: 'auto' = nach Plattengröße, sonst ein fester Name. */
export function chooseProfile(state, choice, { sizeProfile, nowIso = null } = {}) {
  const prev = state && typeof state === 'object' ? state : { version: 1, origin: 'existing' };
  if (choice === 'auto') return { ...prev, version: 1, mode: 'auto', base: sizeProfile, decidedAt: nowIso };
  if (!PROFILE_ORDER.includes(choice)) throw new Error('unbekanntes Profil');
  return { ...prev, version: 1, mode: 'fixed', base: choice, decidedAt: nowIso };
}

// ── Gespeicherter Stand: ${DATA_DIR}/storage-profile.json ───────────────────
// Geschrieben von DVhub (Dienstbenutzer), gelesen von DVhub beim Start und von
// pg-write-tuning.sh / storage-limits.sh (root, S7 a/S8 a) — die lesen NUR das
// Feld "effective" und prüfen es gegen die feste Liste der Profilnamen.
export const PROFILE_FILE = 'storage-profile.json';

export function readProfileState(dataDir, readFile = (f) => fs.readFileSync(f, 'utf8')) {
  if (!dataDir) return null;
  try {
    const j = JSON.parse(readFile(path.join(dataDir, PROFILE_FILE), 'utf8'));
    return j && typeof j === 'object' && PROFILE_ORDER.includes(j.base) ? j : null;
  } catch { return null; }
}

export function writeProfileState(dataDir, st, { writeFile = fs.writeFileSync, rename = fs.renameSync } = {}) {
  if (!dataDir) return false;
  const f = path.join(dataDir, PROFILE_FILE);
  try {
    writeFile(`${f}.tmp`, `${JSON.stringify(st, null, 2)}\n`);
    rename(`${f}.tmp`, f);
    return true;
  } catch { return false; }
}

/** Profil, das beim Start gilt (gespeichert, sonst „groß“ = Verhalten bis 1.0.12). */
export function startupProfile(dataDir, readFile) {
  const st = readProfileState(dataDir, readFile);
  return PROFILES[st?.effective] || PROFILES[st?.base] || PROFILES.gross;
}
