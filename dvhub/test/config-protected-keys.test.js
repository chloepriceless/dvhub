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

// Handy-App (Codex R5): Schalter und Relay hängen an der Schlüsseldatei dieser
// Box — normales Speichern und „nur Einstellungen“ lassen sie, wie die Box sie hat.
test('mobileLink bleibt beim Speichern und beim Import „nur Einstellungen“', () => {
  const cur = { mobileLink: { enabled: true, relayUrl: 'wss://relay.dvhub.de/v1/ws' } };
  const save = { mobileLink: { enabled: false } };
  protectOwnRouteKeys(save, cur);
  assert.deepEqual(save.mobileLink, cur.mobileLink);
  const imp = { mobileLink: { enabled: false, relayUrl: 'wss://alt.example.org/v1/ws' } };
  const carried = protectOwnRouteKeys(imp, cur, { isImport: true });
  assert.deepEqual(imp.mobileLink, cur.mobileLink);
  // Geräte-Tausch: die Werte der Datei ziehen mit um.
  applyCarriedKeys(imp, carried);
  assert.equal(imp.mobileLink.relayUrl, 'wss://alt.example.org/v1/ws');
});

// Strix L-0006 (30.10.2026): licensing.* (Keygen-Konto, Aktivierungs-Proxy,
// Node-Lock) ist Lizenz-Infrastruktur. Weder Speichern noch Import — auch kein
// Geräte-Tausch — dürfen sie ändern; sonst ließe sich der Lizenzschlüssel per
// POST /api/config an einen fremden Server umleiten.
test('licensing bleibt beim Speichern, beim Import und beim Geräte-Tausch wie auf der Box', () => {
  const cur = { licensing: { keygenAccount: 'acct', nodeLock: false } };
  const evil = () => ({ licensing: { keygenAccount: 'acct', activationProxyUrl: 'https://evil.example.net/x', nodeLock: false } });
  const save = evil();
  protectOwnRouteKeys(save, cur);
  assert.deepEqual(save.licensing, cur.licensing);
  const imp = evil();
  const carried = protectOwnRouteKeys(imp, cur, { isImport: true });
  applyCarriedKeys(imp, carried);
  assert.deepEqual(imp.licensing, cur.licensing);
  const fresh = evil();
  protectOwnRouteKeys(fresh, {});
  assert.equal('licensing' in fresh, false, 'ohne eigenen Eintrag gelten die Werte aus dem Code');
});

// Strix T-0001 (30.10.2026): config.support.relay geht vor relay.json — über
// POST /api/config ließ sich das Relay des Support-Tunnels umbiegen (Folge:
// Support-Ausfall; der Hostschlüssel ist gepinnt). Geschützt wird nur dieser
// Pfad: support.localUser und support.tunnel stellt der Kunde selbst.
const relayBox = () => ({ support: { relay: { host: 'support.dvhub.de', shellPort: 49101, webPort: 49102 }, localUser: { enabled: true } } });
const relayFile = () => ({ support: { relay: { host: 'evil.example.net', shellPort: 1, webPort: 2 }, localUser: { enabled: false }, tunnel: { autoCloseMin: 30 } } });

test('T-0001: Speichern ändert support.relay nicht, die übrigen support-Werte schon', () => {
  const incoming = relayFile();
  protectOwnRouteKeys(incoming, relayBox());
  assert.deepEqual(incoming.support.relay, relayBox().support.relay);
  assert.deepEqual(incoming.support.localUser, { enabled: false });
  assert.deepEqual(incoming.support.tunnel, { autoCloseMin: 30 });
});

test('T-0001: Speichern ohne Relay auf der Box bringt keins mit', () => {
  const incoming = relayFile();
  protectOwnRouteKeys(incoming, { support: { localUser: { enabled: true } } });
  assert.equal('relay' in incoming.support, false);
});

test('T-0001: Import nur Einstellungen → Relay der Box; Geräte-Tausch → Relay aus der Datei', () => {
  const a = relayFile();
  protectOwnRouteKeys(a, relayBox(), { isImport: true });
  assert.deepEqual(a.support.relay, relayBox().support.relay);
  const b = relayFile();
  const carried = protectOwnRouteKeys(b, relayBox(), { isImport: true });
  applyCarriedKeys(b, carried);
  assert.deepEqual(b.support.relay, relayFile().support.relay);
});
