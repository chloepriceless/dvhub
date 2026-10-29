// Einordnung von Ziel-Hosts für die SSRF-Prüfungen (Strix-Fund 29.10.2026):
// eine Definition von „intern“ für alle Schreibweisen, die new URL() liefert
// oder ein Nutzer eintippt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHost, isInternalHost, isPrivateOrLoopbackHost } from '../services/host-address.js';

const cases = [
  ['localhost', 'loopback'], ['LOCALHOST.', 'loopback'], ['kiosk.localhost', 'loopback'],
  ['127.0.0.1', 'loopback'], ['127.0.0.2', 'loopback'], ['127.255.255.254', 'loopback'],
  ['::1', 'loopback'], ['[::1]', 'loopback'], ['[0:0:0:0:0:0:0:1]', 'loopback'],
  ['::ffff:127.0.0.1', 'loopback'], ['[::ffff:7f00:1]', 'loopback'],
  ['0.0.0.0', 'unspecified'], ['[::]', 'unspecified'], ['0.1.2.3', 'unspecified'],
  ['169.254.169.254', 'linklocal'], ['[fe80::1]', 'linklocal'], ['[fe80::1%25eth0]', 'linklocal'], ['fe80::1%eth0', 'linklocal'],
  ['10.1.2.3', 'private'], ['172.16.0.1', 'private'], ['172.31.255.255', 'private'], ['192.168.1.60', 'private'],
  ['[fd00::5]', 'private'], ['[fc12::1]', 'private'], ['[::ffff:192.168.1.5]', 'private'], ['[::ffff:c0a8:105]', 'private'],
  ['172.32.0.1', 'public'], ['8.8.8.8', 'public'], ['[2001:db8::1]', 'public'], ['[::ffff:8.8.8.8]', 'public'],
  ['dvhub.online', 'name'], ['', 'invalid'], ['999.1.1.1', 'invalid'], ['[zz::1]', 'invalid'],
];

for (const [host, kind] of cases) {
  test(`classifyHost(${JSON.stringify(host)}) → ${kind}`, () => {
    assert.equal(classifyHost(host), kind);
  });
}

test('isInternalHost: loopback, private, link-local and unspecified; names and public addresses are not', () => {
  for (const h of ['[::1]', '127.0.0.2', '0.0.0.0', '169.254.169.254', '[fe80::1]', '192.168.1.5', '[fd00::5]', 'localhost']) {
    assert.equal(isInternalHost(h), true, h);
  }
  for (const h of ['8.8.8.8', 'dvhub.online', '[2001:db8::1]']) assert.equal(isInternalHost(h), false, h);
});

test('isPrivateOrLoopbackHost (allowlist): box and home network only — not link-local, not unspecified', () => {
  for (const h of ['[::1]', '127.0.0.1', 'localhost', '192.168.1.60', '10.0.0.1', '[fd00::5]', '[::ffff:192.168.1.5]']) {
    assert.equal(isPrivateOrLoopbackHost(h), true, h);
  }
  for (const h of ['169.254.169.254', '[fe80::1]', '0.0.0.0', '[::]', '8.8.8.8', 'dvhub.online', '']) {
    assert.equal(isPrivateOrLoopbackHost(h), false, h);
  }
});

// Gleiches für das allgemeine Speichern der Config (restoreRedacted): neue
// ntfy-Adresse auf anderem Server + '***' darf den Token nicht mitnehmen.
test('restoreRedacted: ntfy token "***" is only restored for the same server', async () => {
  const { restoreRedacted } = await import('../config-redaction.js');
  const current = { notifications: { providers: { ntfy: { topicUrl: 'https://ntfy.example.org/a', token: 'tk' } } } };
  const foreign = restoreRedacted({ notifications: { providers: { ntfy: { topicUrl: 'https://attacker.example.net/a', token: '***' } } } }, current);
  assert.equal(foreign.notifications.providers.ntfy.token, '');
  const same = restoreRedacted({ notifications: { providers: { ntfy: { topicUrl: 'https://ntfy.example.org/b', token: '***' } } } }, current);
  assert.equal(same.notifications.providers.ntfy.token, 'tk');
});
