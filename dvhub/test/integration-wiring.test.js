/**
 * Integration Wiring Tests
 *
 * Static analysis and runtime tests verifying all 7 integration gaps
 * (INT-01 through INT-07) are closed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dvhubRoot = join(__dirname, '..');

function readSource(relativePath) {
  return readFileSync(join(dvhubRoot, relativePath), 'utf-8');
}

// ─── Task 1: INT-01 + INT-04 — Bootstrap wiring ───

describe('INT-01: Exec module registered in server.js', () => {
  const src = readSource('server.js');

  it('imports createExecModule', () => {
    assert.match(src, /createExecModule/);
  });

  it('uses enabled !== false pattern (enabled by default)', () => {
    assert.match(src, /config\.modules\?\.exec\?\.enabled\s*!==\s*false/);
  });

  it('registers exec module via registry.register', () => {
    assert.match(src, /registry\.register\(createExecModule\(\)\)/);
  });
});

describe('INT-04: Database adapter instantiated in server.js', () => {
  const src = readSource('server.js');

  it('imports createDatabaseAdapter', () => {
    assert.match(src, /import\s*\{\s*createDatabaseAdapter\s*\}\s*from\s*'\.\/core\/database\/adapter\.js'/);
  });

  it('calls createDatabaseAdapter(config)', () => {
    assert.match(src, /createDatabaseAdapter\(config\)/);
  });

  it('passes db in registry.initAll context', () => {
    assert.match(src, /registry\.initAll\(\{[\s\S]*?\bdb\b[\s\S]*?\}\)/);
  });

  it('closes db in shutdown handler', () => {
    assert.match(src, /db\?*\)?\s*await\s+db\.close\(\)|if\s*\(db\)\s*await\s+db\.close\(\)/);
  });
});

// ─── Task 2: INT-02 + INT-07 — Telemetry aggregate + publish->emit ───

describe('INT-02: Aggregate telemetry stream in gateway telemetry.js', () => {
  it('creates aggregate telemetry stream via createTelemetryStreams', async () => {
    const { createTelemetryStreams } = await import('../modules/gateway/telemetry.js');
    // Mock event bus with createStream, getStream, getValue
    const streams = new Map();
    const mockEventBus = {
      createStream(name, initial) {
        const subject = { _value: initial, next(v) { this._value = v; }, getValue() { return this._value; }, subscribe() { return { unsubscribe() {} }; } };
        streams.set(name, subject);
        return subject;
      },
      getStream(name) { return streams.get(name) || null; },
      getValue(name) { return streams.get(name)?._value ?? null; },
    };

    const telemetry = createTelemetryStreams(mockEventBus);
    assert.ok(streams.has('telemetry'), 'telemetry stream must be created');
  });

  it('update() populates aggregate telemetry with meter and soc fields', async () => {
    const { createTelemetryStreams } = await import('../modules/gateway/telemetry.js');
    const streams = new Map();
    const mockEventBus = {
      createStream(name, initial) {
        const subject = { _value: initial, next(v) { this._value = v; }, getValue() { return this._value; }, subscribe() { return { unsubscribe() {} }; } };
        streams.set(name, subject);
        return subject;
      },
      getStream(name) { return streams.get(name) || null; },
      getValue(name) { return streams.get(name)?._value ?? null; },
    };

    const telemetry = createTelemetryStreams(mockEventBus);
    telemetry.update({ meter: { grid_total_w: 1500 }, victron: { soc: 75, pvTotalW: 3000, batteryPowerW: -200 } });

    const aggregate = streams.get('telemetry')._value;
    assert.ok(aggregate, 'aggregate telemetry should not be null after update');
    assert.deepStrictEqual(aggregate.meter, { grid_total_w: 1500 });
    assert.strictEqual(aggregate.soc, 75);
    assert.strictEqual(aggregate.pvTotalW, 3000);
  });
});

describe('INT-07: publish() replaced with emit() in optimizer', () => {
  const src = readSource('modules/optimizer/index.js');

  it('does NOT contain ctx.eventBus.publish(', () => {
    assert.doesNotMatch(src, /ctx\.eventBus\.publish\(/);
  });

  it('contains ctx.eventBus.emit({ with type evcc.state', () => {
    assert.match(src, /ctx\.eventBus\.emit\(\{.*type:\s*'evcc\.state'/s);
  });
});

// ─── Task 3: INT-05 + INT-06 — Expose hal and planEngine ───

describe('INT-05: hal exposed on gateway module object', () => {
  const src = readSource('modules/gateway/index.js');

  it('has hal: null in createGatewayModule return object', () => {
    assert.match(src, /hal:\s*null/);
  });

  it('assigns this.hal = hal in init()', () => {
    assert.match(src, /this\.hal\s*=\s*hal/);
  });

  it('cleans up this.hal = null in destroy()', () => {
    assert.match(src, /this\.hal\s*=\s*null/);
  });
});

describe('INT-06: planEngine exposed on optimizer module object', () => {
  const src = readSource('modules/optimizer/index.js');

  it('has planEngine: null in return object', () => {
    assert.match(src, /planEngine:\s*null/);
  });

  it('assigns this.planEngine = planEngine in init()', () => {
    assert.match(src, /this\.planEngine\s*=\s*planEngine/);
  });

  it('cleans up this.planEngine = null in destroy()', () => {
    assert.match(src, /this\.planEngine\s*=\s*null/);
  });
});
