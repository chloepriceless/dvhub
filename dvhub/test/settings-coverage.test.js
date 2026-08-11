// test/settings-coverage.test.js — Abdeckung der Einstellungen (Christin, 29.07.2026)
//
// „Was ist eigentlich noch alles in der Config versteckt, das nie in die GUI
// gewandert ist?" — 345 Config-Blätter, davon hatten 90 kein Bedienelement.
// Ohne Wächter wächst diese Lücke bei jedem neuen Feature weiter, weil ein
// Default in createDefaultConfig schneller geschrieben ist als eine
// Felddefinition.
//
// Dieser Test dreht das um: JEDES neue Config-Blatt muss ab jetzt entweder ein
// GUI-Feld bekommen ODER hier ausdrücklich als „gehört nicht in die GUI"
// eingetragen werden — mit Begründung. Die Liste unten ist der Bestand vom
// 29.07.2026; sie darf schrumpfen, aber nur bewusst wachsen.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getConfigDefinition, createDefaultConfig } from '../config-model.js';

// Register-Verdrahtung: Adressen, Funktionscodes, Wortreihenfolge. Gehört dem
// Herstellerprofil, nicht dem Betreiber (siehe MANUFACTURER_MANAGED_PATHS).
const PLUMBING = /^(points|controlWrite|meter|dvControl\.(feedExcessDcPv|dontFeedExcessAcPv|zeroFeedIn))\./;

// Bewusst OHNE Feld in den Einstellungen — je Eintrag der Grund.
const INTENTIONAL = new Map([
  // Eigene Bedienoberfläche an anderer Stelle
  ['schedule.rules', 'Zeitplan-Editor auf der Zeitplan-Seite'],
  ['updateChannel', 'Auswahl im Werkzeug-Bereich (settings.html #updateChannel)'],
  ['evcc.enabled', 'EVCC-Schublade auf der Integrationsseite'],
  ['evcc.url', 'EVCC-Schublade auf der Integrationsseite'],
  ['evcc.dashboardLoadpoint', 'EVCC-Schublade auf der Integrationsseite'],
  ['meterSource.mode', 'Zähler-Assistent auf der Integrationsseite'],
  ['meterSource.label', 'Zähler-Assistent auf der Integrationsseite'],
  ['victron.transport', 'Einrichtungs-Assistent (Herstellerprofil-Schritt)'],

  // Vom Herstellerprofil verwaltet
  ['victron.port', 'Herstellerprofil'],
  ['victron.unitId', 'Herstellerprofil'],
  ['victron.timeoutMs', 'Herstellerprofil'],

  // Interner Zustand, keine Entscheidung des Betreibers
  ['setupCompleted', 'Zustand des Einrichtungs-Assistenten'],
  ['licensing.keygenAccount', 'Lizenz-Infrastruktur, nicht betreiber-einstellbar'],
  ['licensing.nodeLock', 'Lizenz-Infrastruktur'],
  ['licensing.activationProxyUrl', 'Lizenz-Infrastruktur'],
  ['licensing.nodeLockedPolicyIds', 'Lizenz-Infrastruktur'],
  ['monitoring.signingKey', 'Geheimnis, wird nicht im Klartext bedient'],

  // Toter Code — Default vorhanden, wird nirgends gelesen (29.07.2026 geprüft).
  // Gehört entfernt, nicht bedienbar gemacht.
  ['optimizer.capLoadHeadroomW', 'TOT: nur in createDefaultConfig, kein Leser im Code'],

  // Wirkungslos auf dem produktiven Pfad: Migration 018 hat die
  // Aufbewahrungsgrenze auf timeseries_samples entfernt (Rohwerte bleiben
  // dauerhaft, Kompression ab 7 Tagen macht das billig). Nur der alte
  // SQLite-Store wertet den Wert noch aus (telemetry-store.js:533). Ein
  // Bedienelement würde eine Wirkung vortäuschen, die es nicht gibt —
  // das Feld wurde deshalb schon einmal bewusst entfernt (c4736d0f).
  ['telemetry.rawRetentionDays', 'ohne Wirkung auf dem Postgres-Pfad (Migration 018)'],
]);

function leafPaths(obj, prefix = '', out = []) {
  for (const [key, value] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) leafPaths(value, path, out);
    else out.push(path);
  }
  return out;
}

function uncovered() {
  const known = new Set(getConfigDefinition().fields.filter((f) => f.path).map((f) => f.path));
  return leafPaths(createDefaultConfig())
    .filter((p) => !known.has(p))
    .filter((p) => !PLUMBING.test(p));
}

// Bestand am 29.07.2026 nach Runde 2 (Beta-Parameter). Startpunkt waren 90.
// Diese Zahl ist eine SPERRKLINKE: sie darf sinken, aber nicht steigen. Wer sie
// erhöhen will, hat ein Feld vergessen — nicht den Test angepasst.
const MAX_UNCOVERED = 34;

test('kein neues Config-Feld ohne Bedienelement oder ausdrückliche Ausnahme', () => {
  const missing = uncovered().filter((p) => !INTENTIONAL.has(p));
  assert.ok(
    missing.length <= MAX_UNCOVERED,
    `${missing.length} Config-Werte ohne GUI-Feld (erlaubt: ${MAX_UNCOVERED}).\n`
    + 'Neu hinzugekommen ist vermutlich eines davon — entweder eine Felddefinition\n'
    + 'in buildFieldDefinitions ergänzen oder hier in INTENTIONAL mit Grund eintragen:\n'
    + missing.map((p) => '  ' + p).join('\n')
  );
});

test('die Ausnahmeliste enthält keine Karteileichen', () => {
  const open = new Set(uncovered());
  for (const [path, reason] of INTENTIONAL) {
    assert.ok(
      open.has(path),
      `${path} steht als Ausnahme („${reason}"), ist aber gar nicht mehr offen — `
      + 'entweder hat es inzwischen ein Feld bekommen oder der Config-Schlüssel ist weg. Eintrag löschen.'
    );
  }
});

// Die frisch ergänzte Tranche — hier festgenagelt, damit sie nicht still
// wieder verschwindet (etwa bei einem Merge-Konflikt in der Felderliste).
test('Tranche 1 (Geld & Regelung) ist in den Einstellungen angekommen', () => {
  const fields = getConfigDefinition().fields.filter((f) => f.path);
  const expected = [
    'dvControl.negativePriceProtection.enabled',
    'optimizer.minSellPriceCtKwh',
    'optimizer.ruleHorizonHours',
    'zeroFeedIn.deadbandW',
    'zeroFeedIn.revertTimeoutS'
  ];
  for (const path of expected) {
    const field = fields.find((f) => f.path === path);
    assert.ok(field, `${path} hat kein Feld in den Einstellungen`);
    assert.ok(field.label && field.label.length > 3, `${path}: Beschriftung fehlt`);
    assert.ok(field.help && field.help.length > 40, `${path}: Hilfetext fehlt oder ist zu knapp`);
    assert.ok(field.section && field.group, `${path}: Abschnitt/Gruppe fehlt`);
  }
});

// Ein Wert, den der Betreiber einstellen kann, muss auch einen Weg zurück
// haben: die Felddefinition steuert die Typumwandlung in sanitizeRawConfig.
test('jedes neue Feld hat einen brauchbaren Typ', () => {
  // Bestand 29.07.2026 — ein neuer Typ braucht eine Entsprechung in
  // createConfigInput()/parseFieldInput() in public/settings.js, sonst rendert
  // das Feld leer bzw. wird beim Speichern verschluckt.
  const allowed = new Set([
    'number', 'boolean', 'text', 'select', 'dynamicSelect', 'password', 'time', 'array', 'stringList'
  ]);
  for (const field of getConfigDefinition().fields) {
    if (!field.path) continue;
    assert.ok(allowed.has(field.type), `${field.path}: unbekannter Typ „${field.type}"`);
  }
});
