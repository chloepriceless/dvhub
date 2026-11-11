// Einstellungen LUOX/Lumenaza (T-0417): Standard aus, Bereinigung,
// Geheimnisse geschwärzt und im verschlüsselten Export, Felder in den
// Einstellungen „Strompreise“, Preisquelle und Anbieter wählbar.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultConfig, normalizeConfigInput, getConfigDefinition } from '../config-model.js';
import { REDACTED_PATHS, redactConfig, REDACTED } from '../config-redaction.js';
import { collectSecrets } from '../services/config-secrets-crypto.js';

test('Ab Werk: alles aus, keine Zugangsdaten', () => {
  const d = createDefaultConfig().luox;
  assert.deepEqual(d, {
    email: '', password: '', consumerContractId: '', producerContractId: '',
    endCustomerPrice: { enabled: false }, dvSync: { enabled: false },
    partner: { enabled: false, environment: 'prod', clientId: '', clientSecret: '', userId: '' }
  });
});

test('Bereinigung: Vertragsnummern nur Buchstaben/Ziffern/Bindestrich, Schalter streng, Server prod/test', () => {
  const { persistedConfig: c } = normalizeConfigInput({
    luox: {
      email: ' kundin@example.invalid ', password: ' pw ', consumerContractId: '../edit_bank_data', producerContractId: 'P90000001-1',
      endCustomerPrice: { enabled: 'true' }, dvSync: { enabled: true },
      partner: { enabled: 1, environment: 'evil', clientId: ' id ', clientSecret: ' s ', userId: ' u ' }
    }
  });
  assert.equal(c.luox.email, 'kundin@example.invalid');
  assert.equal(c.luox.password, ' pw ', 'Passwort wird nicht getrimmt');
  assert.equal(c.luox.consumerContractId, '', 'Pfad-Ausbruch verworfen');
  assert.equal(c.luox.producerContractId, 'P90000001-1');
  assert.equal(c.luox.dvSync.enabled, true);
  assert.equal(c.luox.partner.environment, 'prod');
  assert.equal(c.luox.partner.clientId, 'id');
  assert.equal(c.luox.partner.clientSecret, ' s ');
  assert.equal(c.luox.partner.userId, 'u');
});

test('Preisquelle „luox“ und Anbieter „luox“ sind gültige Werte', () => {
  const { persistedConfig: c } = normalizeConfigInput({
    epex: { priceSource: 'luox' },
    userEnergyPricing: { mode: 'provider', provider: { name: 'luox', priceBasis: 'net_energy' } }
  });
  assert.equal(c.epex.priceSource, 'luox');
  assert.equal(c.userEnergyPricing.provider.name, 'luox');
});

test('Geheimnisse: geschwärzt in API/Export, im verschlüsselten Export-Bündel enthalten', () => {
  for (const p of ['luox.email', 'luox.password', 'luox.partner.clientId', 'luox.partner.clientSecret']) assert.ok(REDACTED_PATHS.includes(p), p);
  const cfg = { luox: { email: 'kundin@example.invalid', password: 'pw', consumerContractId: 'C1', partner: { clientId: 'id', clientSecret: 'sec', userId: 'u' } } };
  const shown = redactConfig(cfg);
  assert.equal(shown.luox.email, REDACTED);
  assert.equal(shown.luox.password, REDACTED);
  assert.equal(shown.luox.partner.clientSecret, REDACTED);
  assert.equal(shown.luox.consumerContractId, 'C1');
  const secrets = collectSecrets(cfg);
  assert.equal(secrets['luox.password'], 'pw');
  assert.equal(secrets['luox.partner.clientSecret'], 'sec');
});

test('Einstellungsseite: LUOX-Gruppen unter „Strompreise“, Vertragslisten laden aus /api/luox/contracts', () => {
  const def = getConfigDefinition();
  const prices = def.areas.find((a) => a.id === 'prices');
  assert.ok(prices.groups.includes('luox'));
  assert.ok(prices.advanced.includes('luoxPartner'));
  const fields = def.fields.filter((f) => f.path.startsWith('luox.'));
  assert.equal(fields.length, 11);
  for (const f of fields) assert.ok(['luox', 'luoxPartner'].includes(f.group), f.path);
  const consumer = fields.find((f) => f.path === 'luox.consumerContractId');
  assert.equal(consumer.type, 'dynamicSelect');
  assert.equal(consumer.dynamicOptionsUrl, '/api/luox/contracts?kind=consumer');
  assert.match(fields.find((f) => f.path === 'luox.email').groupDescription, /[Ii]noffizielle Portal-Schnittstelle/);
  for (const p of ['luox.email', 'luox.password', 'luox.partner.clientId', 'luox.partner.clientSecret']) {
    assert.equal(fields.find((f) => f.path === p).type, 'password', p);
  }
});
