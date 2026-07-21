import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseSystemdEnvConf, readEosReserveStatus } from '../services/optimizer/eos-reserve-status.js';

// T-RESERVE-VISIBILITY: read-only Sicht auf die eos.service-Env-Gates.

test('parseSystemdEnvConf: Environment-Zeilen, Kommentare, Quotes, Override-Reihenfolge', () => {
  const env = parseSystemdEnvConf(`
# Kommentar
[Service]
Environment=EOS_RESERVE_PRICE_AWARE=1
Environment="EOS_RESERVE_RELEASE_MARGIN=0.20"
Environment=EOS_RESERVE_MIN_SAFETY_FLOOR_WH=1000
ExecStart=/usr/bin/whatever
Environment=EOS_RESERVE_MIN_SAFETY_FLOOR_WH=2000
`);
  assert.equal(env.EOS_RESERVE_PRICE_AWARE, '1');
  assert.equal(env.EOS_RESERVE_RELEASE_MARGIN, '0.20');
  assert.equal(env.EOS_RESERVE_MIN_SAFETY_FLOOR_WH, '2000', 'spätere Zeile überschreibt (systemd-Semantik)');
  assert.equal(env.ExecStart, undefined);
});

test('readEosReserveStatus: liest *.conf (nicht .bak), typisiert die Gates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eos-dropin-'));
  fs.writeFileSync(path.join(dir, 'reserve.conf'),
    'Environment=EOS_RESERVE_PRICE_AWARE=1\nEnvironment=EOS_RESERVE_RELEASE_MARGIN=0.20\n'
    + 'Environment=EOS_RESERVE_MIN_SAFETY_FLOOR_WH=1000\nEnvironment=EOS_RESERVE_WATERFALL=1\n');
  fs.writeFileSync(path.join(dir, 'reserve.conf.bak-alt'), 'Environment=EOS_RESERVE_WATERFALL=0\n');
  const st = readEosReserveStatus({ dir });
  assert.equal(st.available, true);
  assert.deepEqual(st.sourceFiles, ['reserve.conf'], '.bak wird ignoriert');
  assert.equal(st.gates.priceAware, true);
  assert.equal(st.gates.releaseMargin, 0.20);
  assert.equal(st.gates.safetyFloorWh, 1000);
  assert.equal(st.gates.waterfall, true, '.bak (WATERFALL=0) hat NICHT gewonnen');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readEosReserveStatus: fehlendes Verzeichnis → available:false (kein Raten)', () => {
  const st = readEosReserveStatus({ dir: '/nonexistent/eos.service.d' });
  assert.equal(st.available, false);
  assert.match(st.reason, /dropin_dir_unreadable/);
});
