// test/config-preisapi-migration.test.js — Paritätsfund (dvhub-rs HANDOVER):
// Die Umstellung api.dvhub.de → dvhub.online in normalizeConfigInput griff
// nie, weil der Feld-Pass den alten Wert vorher als „invalid option“
// verwarf. Ergebnis war zwar dieselbe Adresse, aber mit einer irreführenden
// Warnung bei jedem Laden. Jetzt wird vor dem Feld-Pass umgeschrieben.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfigInput } from '../config-model.js';

for (const legacy of ['https://api.dvhub.de', 'http://api.dvhub.de/', 'HTTPS://API.DVHUB.DE']) {
  test(`epex.priceApiUrl ${legacy} → https://dvhub.online ohne Warnung`, () => {
    const n = normalizeConfigInput({ epex: { priceApiUrl: legacy } });
    assert.equal(n.rawConfig.epex.priceApiUrl, 'https://dvhub.online');
    assert.equal(n.persistedConfig.epex.priceApiUrl, 'https://dvhub.online');
    assert.deepEqual(n.warnings.filter((w) => w.startsWith('epex.priceApiUrl')), []);
  });
}

test('eine andere, unbekannte Adresse bleibt wie bisher verworfen (mit Warnung)', () => {
  const n = normalizeConfigInput({ epex: { priceApiUrl: 'https://api.dvhub.de/v2' } });
  assert.equal(n.persistedConfig.epex.priceApiUrl, 'https://dvhub.online');
  assert.ok(n.warnings.some((w) => w.startsWith('epex.priceApiUrl')));
});
