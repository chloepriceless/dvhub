import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createIntentEmitter } from '../modules/dv/control-intents.js';

describe('createIntentEmitter', () => {
  function mockEventBus() {
    const events = [];
    return {
      emit(event) { events.push(event); },
      events
    };
  }

  it('returns object with emitCurtailment method', () => {
    const bus = mockEventBus();
    const emitter = createIntentEmitter(bus);
    assert.strictEqual(typeof emitter.emitCurtailment, 'function');
  });

  it('emitCurtailment(false, reason) emits curtail intent', () => {
    const bus = mockEventBus();
    const emitter = createIntentEmitter(bus);

    emitter.emitCurtailment(false, 'fc16_addr0_0000');

    assert.strictEqual(bus.events.length, 1);
    const e = bus.events[0];
    assert.strictEqual(e.type, 'control:intent');
    assert.strictEqual(e.source, 'dv');
    assert.strictEqual(e.priority, 2);
    assert.strictEqual(e.action, 'curtail');
    assert.deepStrictEqual(e.targets, {
      feedExcessDcPv: false,
      dontFeedExcessAcPv: true
    });
    assert.strictEqual(e.reason, 'fc16_addr0_0000');
    assert.strictEqual(typeof e.timestamp, 'number');
  });

  it('emitCurtailment(true, reason) emits release intent', () => {
    const bus = mockEventBus();
    const emitter = createIntentEmitter(bus);

    emitter.emitCurtailment(true, 'fc16_addr0_ffff');

    assert.strictEqual(bus.events.length, 1);
    const e = bus.events[0];
    assert.strictEqual(e.type, 'control:intent');
    assert.strictEqual(e.source, 'dv');
    assert.strictEqual(e.priority, 2);
    assert.strictEqual(e.action, 'release');
    assert.deepStrictEqual(e.targets, {
      feedExcessDcPv: true,
      dontFeedExcessAcPv: false
    });
    assert.strictEqual(e.reason, 'fc16_addr0_ffff');
    assert.strictEqual(typeof e.timestamp, 'number');
  });
});
