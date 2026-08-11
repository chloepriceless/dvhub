// test/db-actions-placement.test.js — Datenbank-Handlungen gehören zu ihren
// Einstellungen, nicht in die Kopfzeile der Historie (Christin, 29.07.2026).
//
// Ausgangslage: vier Schaltflächen standen in der Kopfzeile der HISTORIE, direkt
// neben „CSV-Export" — darunter „DB wiederherstellen", das mit `pg_restore
// --clean` die vorhandenen Daten überschreibt und nicht umkehrbar ist. Auf einer
// Seite, die man täglich zum Anschauen öffnet. Ihre Konfiguration (Zeitplan,
// Ziel, SMB-Zugang, Aufbewahrung) lag längst in den Einstellungen unter
// „Geplantes Datenbank-Backup".
//
// Der Test hält beide Richtungen fest, damit die Knöpfe bei einem künftigen
// Umbau der Historie nicht zurückwandern.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const HISTORY_HTML = read('../public/history.html');
const HISTORY_JS = read('../public/history.js');
const SETTINGS_JS = read('../public/settings.js');

const REMOVED_IDS = [
  'historyDbBackupFullBtn',
  'historyDbBackup15mBtn',
  'historyDbBackupRunBtn',
  'historyDbRestoreBtn',
  'historyDbRestoreFile'
];

test('die Historie trägt keine Datenbank-Schaltflächen mehr', () => {
  for (const id of REMOVED_IDS) {
    assert.ok(!HISTORY_HTML.includes(id), `history.html enthält noch ${id}`);
    assert.ok(!HISTORY_JS.includes(id), `history.js verdrahtet noch ${id}`);
  }
});

test('die zerstörerischen Endpunkte werden aus der Historie nicht mehr aufgerufen', () => {
  assert.ok(!HISTORY_JS.includes('/api/db/restore'), 'history.js ruft noch die Wiederherstellung');
  assert.ok(!HISTORY_JS.includes('/api/db/backup'), 'history.js ruft noch die Backup-Endpunkte');
});

test('die Historie behält ihre eigenen Handlungen', () => {
  // Der Umbau darf nicht zu viel mitgenommen haben.
  assert.ok(HISTORY_HTML.includes('historyBackfillBtn'), 'Preise nachladen fehlt');
  assert.ok(HISTORY_HTML.includes('historyExportCsvBtn'), 'CSV-Export fehlt');
  assert.ok(HISTORY_JS.includes('triggerCsvExport'), 'CSV-Export-Logik fehlt');
});

test('die Einstellungen führen die vier Handlungen bei ihrer Gruppe', () => {
  assert.ok(SETTINGS_JS.includes('GROUP_ACTIONS'), 'Registrierung fehlt');
  // An die Gruppe gebunden, in der auch Zeitplan, Ziel und Aufbewahrung stehen.
  assert.match(SETTINGS_JS, /GROUP_ACTIONS\s*=\s*\{\s*\n\s*dbBackup:/, 'nicht an die dbBackup-Gruppe gebunden');
  for (const endpoint of ['/api/db/backup?scope=', '/api/db/backup/run', '/api/db/restore']) {
    assert.ok(SETTINGS_JS.includes(endpoint), `settings.js ruft ${endpoint} nicht`);
  }
});

test('die Wiederherstellung fragt vorher nach und ist als gefährlich gekennzeichnet', () => {
  const block = SETTINGS_JS.slice(SETTINGS_JS.indexOf("id: 'dbRestore'"));
  const body = block.slice(0, block.indexOf('\n    }\n  ]'));
  assert.ok(body.includes('danger: true'), 'nicht als gefährlich markiert');
  assert.ok(body.includes('dvConfirm') || body.includes('window.confirm'), 'keine Rückfrage vor dem Überschreiben');
  assert.ok(/nicht umkehrbar|NICHT umkehrbar/i.test(body), 'die Rückfrage benennt die Unumkehrbarkeit nicht');
});

// Die Gruppe muss es geben, sonst hängen die Handlungen ins Leere.
test('die Gruppe dbBackup existiert in den Felddefinitionen', async () => {
  const { getConfigDefinition } = await import('../config-model.js');
  const fields = getConfigDefinition().fields.filter((f) => f.path && f.group === 'dbBackup');
  assert.ok(fields.length >= 8, `nur ${fields.length} Felder in der Gruppe dbBackup`);
  assert.ok(fields.some((f) => f.path === 'dbBackup.enabled'));
  assert.ok(fields.some((f) => f.path === 'dbBackup.destinationDir'));
});
