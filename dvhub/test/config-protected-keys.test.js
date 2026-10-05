import test from 'node:test';
import assert from 'node:assert/strict';
import { protectOwnRouteKeys, applyCarriedKeys } from '../services/config-protected-keys.js';

const box = () => ({
  installerPortal: { enabled: false },
  datenspende: { enabled: false },
  ortsnetz: { enabled: true }
});
const file = () => ({
  installerPortal: { enabled: true, allowTunnel: true },
  datenspende: { enabled: true, sources: { pv: true } },
  ortsnetz: { enabled: false },
  httpPort: 80
});

test('Speichern: ein alter Entwurf ändert keinen der drei Schalter', () => {
  const incoming = file();
  protectOwnRouteKeys(incoming, box());
  assert.deepEqual(incoming.installerPortal, { enabled: false });
  assert.deepEqual(incoming.datenspende, { enabled: false });
  assert.deepEqual(incoming.ortsnetz, { enabled: true });
  assert.equal(incoming.httpPort, 80);
});

test('Speichern: fehlt der Schlüssel auf der Box, bringt ihn der Entwurf nicht mit', () => {
  const incoming = file();
  protectOwnRouteKeys(incoming, {});
  assert.equal('installerPortal' in incoming, false);
  assert.equal('datenspende' in incoming, false);
  assert.equal('ortsnetz' in incoming, false);
});

test('Import ohne Geräte-Tausch: Fernzugang und Datenspende bleiben, Ortsnetz kommt aus der Datei', () => {
  const incoming = file();
  protectOwnRouteKeys(incoming, box(), { isImport: true });
  assert.deepEqual(incoming.installerPortal, { enabled: false });
  assert.deepEqual(incoming.datenspende, { enabled: false });
  assert.deepEqual(incoming.ortsnetz, { enabled: false });
});

test('Geräte-Tausch: alle drei Schalter ziehen eins zu eins um', () => {
  const incoming = file();
  const carried = protectOwnRouteKeys(incoming, box(), { isImport: true });
  const applied = applyCarriedKeys(incoming, carried);
  assert.deepEqual(applied, ['installerPortal', 'datenspende']);
  assert.deepEqual(incoming.installerPortal, { enabled: true, allowTunnel: true });
  assert.deepEqual(incoming.datenspende, { enabled: true, sources: { pv: true } });
  assert.deepEqual(incoming.ortsnetz, { enabled: false });
});

test('Geräte-Tausch: was die Datei nicht enthält, bleibt wie auf der Box', () => {
  const incoming = { httpPort: 80 };
  const carried = protectOwnRouteKeys(incoming, box(), { isImport: true });
  assert.deepEqual(applyCarriedKeys(incoming, carried), []);
  assert.deepEqual(incoming.datenspende, { enabled: false });
});
