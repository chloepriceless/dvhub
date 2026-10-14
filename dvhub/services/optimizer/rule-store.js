// services/optimizer/rule-store.js — Ablage der Plan-Regeln für einen Neustart.
//
// Plan-Regeln (source 'forecast_optimizer', vom EOS-Plan oder dem eingebauten
// Optimizer) ändern sich jede Viertelstunde und gehören nicht in config.json:
// Dort gehen beim Speichern Felder wie optimizer/closedLoopHold verloren, und
// jedes Speichern legt eine Config-Sicherung an (2026-10-14). Im Betrieb leben
// sie nur im Speicher; diese Datei hält sie vollständig (inkl. von Hand
// abgeschalteter Slots) über einen Neustart, bis der nächste Lauf neu plant.

import fs from 'node:fs';
import path from 'node:path';

export const OPTIMIZER_RULES_FILE = 'optimizer-rules.json';
export const OPTIMIZER_RULE_SOURCE = 'forecast_optimizer';

export const isOptimizerRule = (rule) => !!rule && typeof rule === 'object' && rule.source === OPTIMIZER_RULE_SOURCE;

export function optimizerRulesPath(dataDir) {
  return dataDir ? path.join(dataDir, OPTIMIZER_RULES_FILE) : null;
}

// Laufzeit-Markierungen (z. B. _wasActive) nicht ablegen.
function stripRuntime(rule) {
  const out = {};
  for (const [k, v] of Object.entries(rule)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

/** Abgelegte Plan-Regeln lesen; abgelaufene Slots fallen weg. Fehlt/kaputt → []. */
export function readOptimizerRules(file, nowMs = Date.now()) {
  if (!file) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rules = Array.isArray(data?.rules) ? data.rules : [];
    return rules
      .filter(isOptimizerRule)
      .filter((r) => !(Number.isFinite(Number(r.slotEndTs)) && Number(r.slotEndTs) <= nowMs))
      .map(stripRuntime);
  } catch {
    return [];
  }
}

/**
 * Schreibt die Plan-Regeln aus dem laufenden Zustand, aber nur wenn sie sich
 * geändert haben (atomar: daneben schreiben, dann umbenennen).
 */
export function createOptimizerRuleStore({ file, onError = () => {}, now = () => Date.now() } = {}) {
  let lastJson = null;
  return {
    file,
    save(allRules) {
      if (!file) return false;
      const rules = (Array.isArray(allRules) ? allRules : []).filter(isOptimizerRule).map(stripRuntime);
      const json = JSON.stringify(rules);
      if (json === lastJson) return false;
      try {
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date(now()).toISOString(), rules }));
        fs.renameSync(tmp, file);
        lastJson = json;
        return true;
      } catch (e) {
        onError(e);
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Regeln von Hand und der Börsenautomatik (alles außer Plan-Regeln), seit
// 2026-10-14 ebenfalls nicht mehr in config.json: Sie ändern sich im Betrieb
// (Dashboard, Automatik, Abschalten nach Ablauf/Stop-SoC). In der Config
// erzeugte jede Änderung eine Config-Sicherung und ein Neuladen, und eine
// Seite mit altem Stand konnte sie zurücksetzen. Die Config bleibt für
// Einstellungen; Export und Import tragen die Regeln weiter mit.
export const SCHEDULE_RULES_FILE = 'schedule-rules.json';

export function scheduleRulesPath(dataDir) {
  return dataDir ? path.join(dataDir, SCHEDULE_RULES_FILE) : null;
}

/**
 * Abgelegte Regeln lesen. `null`, wenn es die Datei (noch) nicht gibt — dann
 * übernimmt der Start die Regeln einmalig aus der Config. Kaputte Datei → [].
 */
export function readScheduleRules(file, { onError = () => {} } = {}) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (Array.isArray(data?.rules) ? data.rules : [])
      .filter((r) => r && typeof r === 'object' && !Array.isArray(r) && !isOptimizerRule(r))
      .map(stripRuntime);
  } catch (e) {
    onError(e);
    return [];
  }
}

export function createScheduleRuleStore({ file, onError = () => {}, now = () => Date.now() } = {}) {
  let lastJson = null;
  return {
    file,
    /** Schreibt die Nicht-Plan-Regeln, wenn sie sich geändert haben. true = geschrieben. */
    save(allRules, { force = false } = {}) {
      if (!file) return false;
      const rules = (Array.isArray(allRules) ? allRules : [])
        .filter((r) => r && typeof r === 'object' && !Array.isArray(r) && !isOptimizerRule(r))
        .map(stripRuntime);
      const json = JSON.stringify(rules);
      if (!force && json === lastJson) return false;
      try {
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date(now()).toISOString(), rules }));
        fs.renameSync(tmp, file);
        lastJson = json;
        return true;
      } catch (e) {
        onError(e);
        return false;
      }
    },
    /** Stand nach dem Lesen beim Start merken (kein unnötiges Schreiben). */
    prime(rules) {
      lastJson = JSON.stringify((Array.isArray(rules) ? rules : []).filter((r) => !isOptimizerRule(r)).map(stripRuntime));
    },
  };
}
