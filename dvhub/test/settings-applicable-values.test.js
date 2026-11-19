// Einstellungen → Strompreise → Marktprämie: Quelle und Stand der anzulegenden
// Werte als Hinweis unter „Quelle der anzulegenden Werte“ (19.11.2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadHelpers() {
  const settingsPath = fileURLToPath(new URL('../public/settings.js', import.meta.url));
  const source = fs.readFileSync(settingsPath, 'utf8');
  const sandbox = {
    console,
    Intl,
    globalThis: {},
    window: {
      DVhubCommon: {
        escapeHtml: (v) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
      },
      addEventListener() {},
      setTimeout() {}
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: path.basename(settingsPath) });
  return sandbox.DVhubSettingsApplicableValues;
}

const { applicableValueStatusText } = loadHelpers();
const months = { first: '2022-07', last: '2026-12', count: 54, fullFeedCount: 54 };

test('Stand von dvhub.online: Quelle, Datum (Berlin) und Inbetriebnahme-Zeitraum', () => {
  const r = applicableValueStatusText({ needed: true, source: 'dvhub', via: 'dvhub_online', updatedAt: '2026-11-18T23:40:00.000Z', months, lastAttemptOk: true });
  assert.equal(r.text, 'Anzulegende Werte: dvhub.online, Stand 19.11.2026 · Inbetriebnahme 07/2022 bis 12/2026');
  assert.equal(r.warn, false);
});

test('Rückfall und Direkt-Quelle werden benannt; Fehlschlag mit Stand warnt', () => {
  const fallback = applicableValueStatusText({ needed: true, source: 'dvhub', via: 'bundesnetzagentur', updatedAt: '2026-11-19T08:00:00.000Z', months, lastAttemptOk: true });
  assert.match(fallback.text, /^Anzulegende Werte: direkt von der Bundesnetzagentur, Stand 19\.11\.2026 .*dvhub\.online war beim letzten Abruf nicht erreichbar/);
  const direct = applicableValueStatusText({ needed: true, source: 'public', via: 'bundesnetzagentur', updatedAt: '2026-11-19T08:00:00.000Z', months, lastAttemptOk: true });
  assert.equal(direct.text, 'Anzulegende Werte: direkt von der Bundesnetzagentur, Stand 19.11.2026 · Inbetriebnahme 07/2022 bis 12/2026');
  const failed = applicableValueStatusText({ needed: true, source: 'dvhub', via: 'dvhub_online', updatedAt: '2026-11-12T05:40:00.000Z', months, lastAttemptOk: false, lastAttemptAt: '2026-11-19T10:00:00.000Z' });
  assert.match(failed.text, /letzter Abruf am 19\.11\.2026 fehlgeschlagen, es gelten die gespeicherten Werte/);
  assert.equal(failed.warn, true);
});

test('Hinweis bleibt nach dem Speichern stehen; die Speicher-Antwort bringt den neuen Stand mit (Codex ead6ef31)', async () => {
  const { loadSettingsPage } = await import('./helpers/settings-page.js');
  const { getConfigDefinition } = await import('../config-model.js');
  const { context } = loadSettingsPage();
  const status = { needed: true, source: 'dvhub', via: 'dvhub_online', updatedAt: '2026-11-19T05:40:00.000Z', months, lastAttemptOk: true };
  context.__load = { config: {}, effectiveConfig: {}, definition: getConfigDefinition(), meta: {}, referenceData: { applicableValues: status } };
  vm.runInContext('loadConfigPayloadState(__load)', context);
  const note = () => vm.runInContext("fieldInfoNote('referenceData.applicableValueSource')", context)?.text;
  assert.match(note(), /^Anzulegende Werte: dvhub\.online, Stand 19\.11\.2026/);
  // saveConfig → applyConfigPayload mit den Feldern der POST-Antwort, ohne referenceData
  context.__saved = { config: {}, effectiveConfig: {}, definition: getConfigDefinition(), meta: {} };
  vm.runInContext('loadConfigPayloadState(__saved)', context);
  assert.match(note() || '', /^Anzulegende Werte: dvhub\.online/);
  // mit referenceData (neue POST-Antwort): neuer Stand
  context.__saved2 = { ...context.__saved, referenceData: { applicableValues: { ...status, source: 'public' } } };
  vm.runInContext('loadConfigPayloadState(__saved2)', context);
  assert.match(note(), /Umstellung auf die Bundesnetzagentur folgt/);
  const source = fs.readFileSync(fileURLToPath(new URL('../public/settings.js', import.meta.url)), 'utf8');
  const save = source.slice(source.indexOf('async function saveConfig('));
  assert.match(save.slice(0, save.indexOf('\n}\n')), /referenceData: payload\.referenceData/);
});

test('Ohne Stand: ohne PV-Anlage kein Abruf; mit Anlage und Fehlschlag eine Warnung', () => {
  const empty = { first: null, last: null, count: 0, fullFeedCount: 0 };
  assert.match(applicableValueStatusText({ needed: false, source: 'dvhub', months: empty }).text, /sobald unten eine PV-Anlage/);
  const failed = applicableValueStatusText({ needed: true, source: 'dvhub', months: empty, lastAttemptOk: false, lastAttemptAt: '2026-11-19T10:00:00.000Z' });
  assert.match(failed.text, /noch keine geladen — der letzte Abruf am 19\.11\.2026 ist fehlgeschlagen/);
  assert.equal(failed.warn, true);
  assert.equal(applicableValueStatusText(null), null);
});
