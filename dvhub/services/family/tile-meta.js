// services/family/tile-meta.js -- Pure heuristic: unit/topic -> icon + accent
// colour (D-02 / D-04) and the power-unit classifier (D-06).
//
// Source of truth: 11-UI-SPEC.md  §"Unit -> icon + colour heuristic".
//
// PURE by design: NO imports, NO side effects, NO DOM access. It must run
// unchanged under both `node:test` (ESM) and the browser. Because the family
// kiosk script `family.js` is a browser IIFE and cannot `import` an ES module
// without a bundler, the chosen Phase 11 approach is: THIS module is the test's
// single source of truth; `family.js` (Plan 05) and `integrations.js` (Plan 04)
// re-declare the SAME `RULES` table inline. This file owns ONLY the module +
// its test -- do not modify family.js / integrations.js here.

// No-match fallback: a generic "signal" tile in Slate.
const FALLBACK = { icon: '📡', color: '#78909c' };

// Ordered rules -- first match wins. `units` is matched against the lowercased
// unit string; `topicIncludes` is matched against a lowercased topic. Unit
// rules are checked across ALL rules first, then topic rules -- so a tile with
// unit `W` AND a topic containing `tesla` resolves as power (⚡/Amber),
// matching the UI-SPEC intent that power units pin the dust-stream colour.
const RULES = [
  { units: ['w', 'kw', 'mw'],            icon: '⚡',  color: '#F7B731' },
  { units: ['wh', 'kwh'],                icon: '🔋', color: '#26de81' },
  { units: ['°c', '°f', 'c', 'k'],       icon: '🌡️', color: '#ff6b6b' },
  { units: ['%'],                        icon: '💧', color: '#4b7bec' },
  { units: ['v', 'a', 'hz'],             icon: '🔌', color: '#22d3ee' },
  { units: ['ct', 'ct/kwh', 'eur', '€'], icon: '💡', color: '#fd9644' },
  { units: ['lx', 'lux'],                icon: '💡', color: '#F7B731' },
  { units: ['ppm', 'µg/m³'],             icon: '💨', color: '#4b7bec' },
  { topicIncludes: ['tesla', 'car', 'ev'], icon: '🚗', color: '#a55eea' },
  { topicIncludes: ['temp', 'klima'],      icon: '🌡️', color: '#ff6b6b' },
];

/**
 * Derive icon + colour purely from a tile's `unit` (preferred) or `topic`
 * (fallback). Returns the Slate FALLBACK when nothing matches.
 * @param {{unit?:string, topic?:string}|null} tile
 * @returns {{icon:string, color:string}}
 */
function autoMeta(tile) {
  const unit = String((tile && tile.unit) || '').trim().toLowerCase();
  const topic = String((tile && tile.topic) || '').toLowerCase();
  // Unit rules first -- across all rules -- so a power unit always wins over a
  // topic match (e.g. unit `W` + topic `tesla` -> ⚡, not 🚗).
  for (const r of RULES) {
    if (r.units && unit && r.units.includes(unit)) {
      return { icon: r.icon, color: r.color };
    }
  }
  // Topic rules only fire when no unit matched.
  for (const r of RULES) {
    if (r.topicIncludes && r.topicIncludes.some(t => topic.includes(t))) {
      return { icon: r.icon, color: r.color };
    }
  }
  return { icon: FALLBACK.icon, color: FALLBACK.color };
}

/**
 * Resolve a tile's final icon + accent colour. An explicitly-set `tile.icon`
 * or `tile.color` ALWAYS wins (the heuristic is skipped for that field); each
 * unset field is auto-derived from the unit/topic heuristic. Icon and colour
 * are resolved independently -- a tile may carry an explicit icon while its
 * colour is still auto-derived, and vice versa.
 * @param {{icon?:string, color?:string, unit?:string, topic?:string}|null} tile
 * @returns {{icon:string, color:string}}
 */
export function resolveTileIconColor(tile) {
  const auto = autoMeta(tile);
  const icon = (tile && typeof tile.icon === 'string' && tile.icon.trim())
    ? tile.icon
    : auto.icon;
  const color = (tile && typeof tile.color === 'string' && tile.color.trim())
    ? tile.color
    : auto.color;
  return { icon, color };
}

// Power units that make an MQTT tile eligible to join the bgFlow dust
// constellation (D-06). Matched case-insensitively.
const POWER_UNITS = new Set(['w', 'kw', 'mw']);

/**
 * True when `unit` denotes electrical power (W / kW / MW), case-insensitive.
 * False for energy (Wh), temperature, percentage, empty / undefined, etc.
 * @param {string|undefined|null} unit
 * @returns {boolean}
 */
export function isPowerUnit(unit) {
  return POWER_UNITS.has(String(unit || '').trim().toLowerCase());
}
