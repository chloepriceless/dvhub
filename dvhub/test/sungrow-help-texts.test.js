// Befund 1.4-3 (Christin 16.11.2026): widersprüchliche Hilfetexte zum Zwei-WR-Split gegen den heutigen Code
// berichtigt. Der Code regelt beide WR einzeln (der Master verteilt NICHT intern, Feldbefund), und bei einem
// Slave-Fehler regelt der Master weiter (nur der Slave geht in den Eigenverbrauch) — nicht „beide zurück".

import test from 'node:test';
import assert from 'node:assert/strict';

import { getConfigDefinition } from '../config-model.js';

function field(path) {
  const f = getConfigDefinition().fields.find((x) => x.path === path);
  assert.ok(f, `Feld ${path} fehlt`);
  return f;
}

test('1.4-3: secondInverter.host-Hilfe sagt NICHT mehr „nie gesteuert / Master verteilt intern"', () => {
  const help = field('sungrow.secondInverter.host').help;
  assert.doesNotMatch(help, /nie gesteuert/, 'der Slave wird mitgeregelt, nicht „nie gesteuert"');
  assert.doesNotMatch(help, /Master verteilt die Vorgabe intern/, 'der Master verteilt NICHT intern');
  assert.match(help, /mitgeregelt/);
  assert.match(help, /verteilt NICHT intern/);
});

test('1.4-3: strategyCharge-Hilfe beschreibt die ECHTE Fehlerpolitik (Slave-Fehler → Master regelt weiter)', () => {
  const help = field('sungrow.secondInverter.strategyCharge').help;
  // Nicht mehr die pauschale (falsche) Aussage „Scheitert EINER … gehen BEIDE zurück".
  assert.doesNotMatch(help, /Scheitert EINER[^.]*gehen BEIDE/);
  assert.match(help, /Scheitert der SLAVE/);
  assert.match(help, /Master regelt mit dessen Anteil weiter/);
  assert.match(help, /scheitert der MASTER[^.]*gehen BEIDE/);
});
