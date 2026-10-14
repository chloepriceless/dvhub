// test/config-warnings-text.test.js — Warnungen beim Laden der Config sind
// Texte (Audit 2026-10-14, Befund 7): Die §14a-Geräte legten Objekte ab, die
// Oberfläche zeigte „[object Object]“.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfigInput } from '../config-model.js';

test('ungültige §14a-Geräte ergeben lesbare Text-Warnungen', () => {
  const r1 = normalizeConfigInput({ paragraph14a: { devices: [{ kind: 'toaster', powerW: 5 }] } });
  const r2 = normalizeConfigInput({ paragraph14a: { devices: 'kaputt' } });
  for (const w of [...r1.warnings, ...r2.warnings]) assert.equal(typeof w, 'string', JSON.stringify(w));
  assert.ok(r1.warnings.includes('paragraph14a.devices[0]: ungültiges Gerät — verworfen'), JSON.stringify(r1.warnings));
  assert.ok(r2.warnings.includes('paragraph14a.devices: keine Liste — verworfen'), JSON.stringify(r2.warnings));
});
