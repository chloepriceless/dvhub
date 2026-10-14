// test/runtime-info.test.js — Container oder native Installation + OS (2026-10-14).
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRuntime } from '../runtime-info.js';

function fakeFs(files) {
  return {
    existsSync: (p) => Object.hasOwn(files, p),
    readFileSync: (p) => { if (!Object.hasOwn(files, p)) throw new Error('ENOENT'); return files[p]; },
  };
}
const DEBIAN = 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\n';

test('Docker-Image (DVHUB_RUNTIME=container): Docker-Container, OS des Basis-Images ergänzend', () => {
  const r = detectRuntime({ env: { DVHUB_RUNTIME: 'container' }, fsImpl: fakeFs({ '/etc/os-release': 'PRETTY_NAME="Alpine Linux v3.21"\n' }), platform: 'linux', arch: 'arm64' });
  assert.deepEqual(r, { kind: 'container', label: 'Docker-Container', os: 'Alpine Linux v3.21', arch: 'arm64', virt: null });
});

test('/.dockerenv ohne Variable zählt ebenfalls als Container', () => {
  const r = detectRuntime({ env: {}, fsImpl: fakeFs({ '/.dockerenv': '', '/etc/os-release': DEBIAN }), platform: 'linux', arch: 'x64' });
  assert.equal(r.kind, 'container');
});

test('native Installation: Betriebssystem aus /etc/os-release', () => {
  const r = detectRuntime({ env: {}, fsImpl: fakeFs({ '/etc/os-release': DEBIAN }), platform: 'linux', arch: 'arm64' });
  assert.deepEqual(r, { kind: 'native', label: 'Debian GNU/Linux 12 (bookworm)', os: 'Debian GNU/Linux 12 (bookworm)', arch: 'arm64', virt: null });
});

test('native Installation in einem LXC-Container (Proxmox): Hinweis im Text', () => {
  const r = detectRuntime({ env: {}, fsImpl: fakeFs({ '/etc/os-release': DEBIAN, '/run/systemd/container': 'lxc\n' }), platform: 'linux', arch: 'x64' });
  assert.equal(r.kind, 'native');
  assert.equal(r.virt, 'lxc');
  assert.equal(r.label, 'Debian GNU/Linux 12 (bookworm) (LXC)');
});

test('ohne os-release: Plattform als Rückfall, unbrauchbare Container-Angabe ignoriert', () => {
  const r = detectRuntime({ env: {}, fsImpl: fakeFs({ '/run/systemd/container': 'x;rm -rf /' }), platform: 'linux', arch: 'x64' });
  assert.equal(r.label, 'linux');
  assert.equal(r.virt, null);
});
