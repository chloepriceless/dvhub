// Kundenfall deye1 (2026-10-06): /opt/dvhub/forecast-venv existierte, der
// pip-Lauf war aber nie durchgegangen — ein venv OHNE Pakete. DVhub prüfte nur
// den Interpreter, meldete „Python vorhanden" und jedes Skript starb mit
// ModuleNotFoundError. pythonEnvStatus() unterscheidet die drei Zustände.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pythonEnvStatus, readProvisionStatus } from '../services/python-bridge/index.js';

function makeVenv({ interpreter = true, modules = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-venv-'));
  if (interpreter) {
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin', 'python3'), '');
  }
  const site = path.join(dir, 'lib', 'python3.12', 'site-packages');
  fs.mkdirSync(site, { recursive: true });
  for (const m of modules) fs.mkdirSync(path.join(site, m));
  return dir;
}

test('kein venv → no_venv', () => {
  const dir = makeVenv({ interpreter: false });
  try {
    const s = pythonEnvStatus(dir);
    assert.equal(s.ok, false);
    assert.equal(s.reason, 'no_venv');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('venv ohne Pakete (Kundenfall) → packages_missing, nicht „verfügbar"', () => {
  // pip und setuptools liegen in einem frischen venv — sie zählen nicht.
  const dir = makeVenv({ modules: ['pip', 'setuptools'] });
  try {
    const s = pythonEnvStatus(dir);
    assert.equal(s.ok, false);
    assert.equal(s.reason, 'packages_missing');
    assert.deepEqual(s.missing, ['numpy', 'pandas', 'pvlib', 'statsforecast']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('teilweise installiert → nennt genau die fehlenden Module', () => {
  const dir = makeVenv({ modules: ['numpy', 'pandas'] });
  try {
    const s = pythonEnvStatus(dir);
    assert.equal(s.ok, false);
    assert.deepEqual(s.missing, ['pvlib', 'statsforecast']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('alle Module da → ok', () => {
  const dir = makeVenv({ modules: ['numpy', 'pandas', 'pvlib', 'statsforecast', 'scipy'] });
  try {
    assert.deepEqual(pythonEnvStatus(dir), { ok: true, reason: null, missing: [] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readProvisionStatus liest den Grund aus forecast-provision.sh, null ohne Datei', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-data-'));
  try {
    assert.equal(readProvisionStatus(dir), null);
    fs.writeFileSync(path.join(dir, 'forecast-venv-status.json'),
      '{"ok":false,"reason":"python_too_old","detail":"Python 3.10.12 gefunden","python":"3.10.12","ts":"2026-10-06T18:00:00Z"}\n');
    assert.equal(readProvisionStatus(dir).reason, 'python_too_old');
    fs.writeFileSync(path.join(dir, 'forecast-venv-status.json'), 'kaputt');
    assert.equal(readProvisionStatus(dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
