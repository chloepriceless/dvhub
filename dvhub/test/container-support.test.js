// test/container-support.test.js — Fern-Support im Docker-Image (2026-10-14).
// Der Entrypoint richtet den Tunnel ein wie support-provision.sh nativ; die
// Konstanten (Relay, gepinnter Hostschlüssel, Support-Schlüssel) müssen in
// beiden Dateien gleich sein, und das Image braucht ssh/autossh/sshd.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const constant = (text, name) => (new RegExp(`^${name}="([^"]+)"`, 'm').exec(text) || [])[1];

test('Entrypoint und support-provision.sh nutzen dieselben Relay- und Support-Schlüssel', () => {
  const prov = read('support-provision.sh');
  const entry = read('docker/docker-entrypoint.sh');
  for (const name of ['RELAY_HOST', 'RELAY_PORT', 'RELAY_USER', 'RELAY_HOSTKEY', 'SUPPORT_PUBKEY']) {
    assert.ok(constant(prov, name), `${name} fehlt in support-provision.sh`);
    assert.equal(constant(entry, name), constant(prov, name), `${name} weicht ab`);
  }
});

test('Docker-Image enthält ssh, autossh und sshd; dvhub hat eine Shell für den Support-Login', () => {
  const df = read('Dockerfile');
  for (const pkg of ['openssh-client-default', 'openssh-keygen', 'openssh-server', 'autossh']) {
    assert.match(df, new RegExp(`\\b${pkg}\\b`), `${pkg} fehlt im Dockerfile`);
  }
  assert.match(df, /adduser [^\n]*-s \/bin\/sh dvhub/);
});

test('Container-sshd: nur 127.0.0.1, nur Schlüssel, nur dvhub, keine Weiterleitungen', () => {
  const entry = read('docker/docker-entrypoint.sh');
  const cfg = /cat > "\$SUP_DIR\/sshd_config" <<SSHD\n([\s\S]*?)\nSSHD/.exec(entry)[1];
  assert.match(cfg, /^ListenAddress 127\.0\.0\.1:/m);
  for (const line of ['PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PermitRootLogin no', 'AllowTcpForwarding no', 'AllowAgentForwarding no', 'X11Forwarding no', 'PermitTunnel no']) {
    assert.ok(cfg.includes(line), `${line} fehlt`);
  }
  assert.match(cfg, /^AllowUsers \$\{RUN_USER\}$/m);
  assert.match(cfg, /^AuthorizedKeysFile \$\{SUP_DIR\}\/support_authorized_keys$/m);
});
