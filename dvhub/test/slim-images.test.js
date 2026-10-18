// Schlanke Images (SPiNE EnergyLink, 2026-10-19): docker/timescaledb-slim und
// docker/eos-slim. Ihre Vorgaben müssen zu den Pins in docker/.env.example
// passen — sonst entstünde ein schlankes Image zu einer anderen Version als
// das offizielle, das die Suite sonst zieht. Die CI baut sie mit den Pins
// (container-dev.yml, publish-slim).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const env = (k) => (read('docker/.env.example').match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
const arg = (file, k) => (read(file).match(new RegExp(`^ARG ${k}="?([^"\\n]*)"?$`, 'm')) || [])[1];

test('TimescaleDB-schlank: Grundlage und Version wie TIMESCALE_TAG', () => {
  const tag = env('TIMESCALE_TAG');
  assert.ok(tag, 'TIMESCALE_TAG in .env.example');
  assert.equal(arg('docker/timescaledb-slim/Dockerfile', 'TS_IMAGE'), `timescale/timescaledb:${tag}`);
  assert.equal(arg('docker/timescaledb-slim/Dockerfile', 'TS_VERSION'), tag.replace(/-pg\d+$/, ''));
});

test('TimescaleDB-schlank: Update-Weg von der vorher ausgelieferten Version', () => {
  const from = arg('docker/timescaledb-slim/Dockerfile', 'TS_UPGRADE_FROM').split(/\s+/).filter(Boolean);
  assert.ok(from.length >= 1);
  assert.ok(!from.includes(arg('docker/timescaledb-slim/Dockerfile', 'TS_VERSION')), 'nicht die eigene Version');
});

test('EOS-schlank: Grundlage zum EOS-Pin, EOSdash fest aus', () => {
  const df = read('docker/eos-slim/Dockerfile');
  assert.equal(arg('docker/eos-slim/Dockerfile', 'EOS_TAG'), env('EOS_TAG'));
  assert.match(df, /EOS_SERVER__STARTUP_EOSDASH=false/);
  assert.match(df, /^FROM scratch$/m, 'eine Schicht — sonst wird nichts kleiner');
  assert.match(read('docker/timescaledb-slim/Dockerfile'), /^FROM scratch$/m);
});

test('Compose: Datenbank-Image wählbar, Vorgabe bleibt das offizielle', () => {
  assert.match(read('docker/compose.yml'), /image: \$\{TIMESCALE_IMAGE:-timescale\/timescaledb\}:\$\{TIMESCALE_TAG:-/);
  assert.match(read('docker/.env.example'), /^# TIMESCALE_IMAGE=docker\.io\/bikinibottomcapital\/timescaledb-slim$/m);
});
