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
