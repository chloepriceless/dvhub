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

// T-FREEZE (2026-07-24): das Herstellerprofil BESITZT victron.* (Register-Map).
// Operator-/Schutz-Parameter derselben Sektion müssen die Profil-Anwendung
// überleben — sonst fällt eine GUI-Einstellung still auf den Hardcode-Default
// zurück, sobald ein Profil aktiv ist (also immer). Genau so war der
// Einfrier-Wächter im ersten Feldtest wirkungslos konfiguriert.
test('Herstellerprofil überschreibt Schutz-/Timing-Parameter der victron-Sektion NICHT', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-profile-carry-'));
  const configPath = path.join(rootDir, 'config.json');
  const manufacturerDir = path.join(rootDir, 'hersteller');
  fs.mkdirSync(manufacturerDir, { recursive: true });

  // Ein Profil, das (wie alle ausgelieferten) KEINEN dieser Werte deklariert.
  fs.writeFileSync(path.join(manufacturerDir, 'victron.json'), JSON.stringify({
    victron: { transport: 'modbus', port: 502, unitId: 100, timeoutMs: 1000 }
  }));
  fs.writeFileSync(configPath, JSON.stringify({
    manufacturer: 'victron',
    victron: {
      host: '10.0.0.5',
      telemetryMaxAgeMs: 45000,
      modbusConnectTimeoutMs: 3000,
      freezeWatchdog: { enabled: true, freezeMs: 60000, minSamples: 15 }
    }
  }));

  const v = loadConfigFile(configPath).effectiveConfig.victron;
  assert.equal(v.port, 502, 'Register-/Transport-Teil kommt weiterhin vom Profil');
  assert.equal(v.telemetryMaxAgeMs, 45000);
  assert.equal(v.modbusConnectTimeoutMs, 3000);
  assert.equal(v.freezeWatchdog.freezeMs, 60000);
  assert.equal(v.freezeWatchdog.minSamples, 15);
  assert.equal(v.freezeWatchdog.minPowerW, 25, 'nicht gesetzte Unterfelder kommen aus den Defaults');
});
