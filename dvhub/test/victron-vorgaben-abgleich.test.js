// Eingebaute Victron-Vorgaben (createDefaultConfig) und mitgeliefertes Profil hersteller/victron.json müssen jedes
// Register gleich kodieren. Die Vorgaben greifen, wenn victron.json fehlt oder kaputt ist; 2704 stand dort mit
// scale 1 und ohne Sonderwerte, das Profil mit scale 10 (Victron zählt 10-W-Schritte), 0 und −1 als Sonderwerte —
// ein Write oder eine Rücknahme hätte 10-fach falsch kodiert, „unbegrenzt“ wäre als raw −1 verworfen worden
// (Codex a5803519 P1, 19.11.2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createDefaultConfig } from '../config-model.js';

const PROFILE = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../hersteller/victron.json', import.meta.url)), 'utf8'));
const ENCODING = ['fc', 'address', 'quantity', 'writeType', 'readType', 'signed', 'scale', 'offset', 'wordOrder', 'rawSentinels', 'rawSentinelMap', 'sumRegisters'];

test('Victron-Vorgaben kodieren jedes Register wie hersteller/victron.json', () => {
  const def = createDefaultConfig();
  const diffs = [];
  let compared = 0;
  for (const block of ['points', 'controlWrite', 'dvControl']) {
    for (const [key, prof] of Object.entries(PROFILE[block] || {})) {
      if (key.startsWith('_') || !prof || typeof prof !== 'object' || Array.isArray(prof)) continue;
      const d = def[block]?.[key];
      if (!d) continue; // nur im Profil (z. B. acInputLimitA): keine Vorgabe, nichts abzugleichen
      compared += 1;
      for (const f of ENCODING) {
        if (JSON.stringify(d[f]) !== JSON.stringify(prof[f])) diffs.push(`${block}.${key}.${f}: Vorgabe ${JSON.stringify(d[f])} ≠ Profil ${JSON.stringify(prof[f])}`);
      }
    }
  }
  assert.ok(compared >= 10, `zu wenig verglichen (${compared})`);
  assert.deepEqual(diffs, []);
});
