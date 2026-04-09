import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfigFile } from '../config-model.js';

test('loadConfigFile builds effective Victron runtime values from hersteller/victron.json', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-manufacturer-profile-'));
  const configPath = path.join(rootDir, 'config.json');
  const manufacturerDir = path.join(rootDir, 'hersteller');
  fs.mkdirSync(manufacturerDir, { recursive: true });

  fs.writeFileSync(path.join(manufacturerDir, 'victron.json'), JSON.stringify({
    victron: {
      transport: 'modbus',
      port: 15020,
      unitId: 77,
      timeoutMs: 9876
    },
    meter: {
      fc: 4,
      address: 1820,
      quantity: 6
    },
    points: {
      soc: {
        enabled: true,
        fc: 4,
        address: 1843,
        quantity: 1,
        signed: false,
        scale: 1,
        offset: 0
      }
    },
    controlWrite: {
      gridSetpointW: {
        enabled: true,
        fc: 6,
        address: 4700,
        writeType: 'int16',
        signed: true,
        scale: 1,
        offset: 0
      }
    },
    dvControl: {
      enabled: true,
      feedExcessDcPv: {
        enabled: true,
        fc: 6,
        address: 4707,
        writeType: 'uint16',
        signed: false,
        scale: 1,
        offset: 0
      },
      dontFeedExcessAcPv: {
        enabled: true,
        fc: 6,
        address: 4708,
        writeType: 'uint16',
        signed: false,
        scale: 1,
        offset: 0
      },
      negativePriceProtection: {
        enabled: true,
        gridSetpointW: -55
      }
    }
  }, null, 2));

  fs.writeFileSync(configPath, JSON.stringify({
    manufacturer: 'victron',
    victron: {
      host: 'venus-gx.local'
    }
  }, null, 2));

  const loaded = loadConfigFile(configPath);

  assert.equal(loaded.effectiveConfig.victron.host, 'venus-gx.local');
  assert.equal(loaded.effectiveConfig.victron.port, 15020);
  assert.equal(loaded.effectiveConfig.victron.unitId, 77);
  assert.equal(loaded.effectiveConfig.victron.timeoutMs, 9876);
  assert.equal(loaded.effectiveConfig.meter.address, 1820);
  assert.equal(loaded.effectiveConfig.points.soc.address, 1843);
  assert.equal(loaded.effectiveConfig.controlWrite.gridSetpointW.address, 4700);
  assert.equal(loaded.effectiveConfig.dvControl.feedExcessDcPv.address, 4707);
  assert.equal(loaded.effectiveConfig.dvControl.dontFeedExcessAcPv.address, 4708);
  assert.equal(loaded.effectiveConfig.dvControl.negativePriceProtection.gridSetpointW, -55);
});
