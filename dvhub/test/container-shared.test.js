// test/container-shared.test.js — Adresse von DVhub für den EOS-Wächter (2026-10-18).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSharedDvhubUrl, DVHUB_URL_FILE } from '../services/container-shared.js';

test('writeSharedDvhubUrl: schreibt die Loopback-Adresse mit dem tatsächlichen Port, Unsinn nicht', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-shared-'));
  assert.equal(writeSharedDvhubUrl(dir, 8081), true);
  assert.equal(fs.readFileSync(path.join(dir, DVHUB_URL_FILE), 'utf8'), 'http://127.0.0.1:8081\n');
  assert.equal(writeSharedDvhubUrl(dir, 'x'), false);
  assert.equal(writeSharedDvhubUrl(dir, 70000), false);
  assert.equal(writeSharedDvhubUrl('', 8080), false);
  assert.equal(writeSharedDvhubUrl(path.join(dir, 'fehlt'), 8080), false, 'fehlendes Verzeichnis wirft nicht');
  assert.equal(fs.readdirSync(dir).length, 1, 'keine Reste der Zwischendatei');
});
