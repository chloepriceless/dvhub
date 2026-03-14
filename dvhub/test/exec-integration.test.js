/**
 * Exec Module Integration Tests
 *
 * Tests the full pipeline: control:intent -> arbitration -> execution.
 * Verifies EXEC-01 (priority resolution), EXEC-02 (all writes through executor),
 * and EXEC-04 (deviation alerting).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createArbitrator } from '../core/arbitrator.js';
import { createExecutor } from '../core/executor.js';
import { createEventBus } from '../core/event-bus.js';

describe('exec integration', () => {
  let arbitrator;
  let executor;
  let eventBus;
  let mockHal;
  let mockDb;
  let intentSub;
  let capturedEvents;

  beforeEach(() => {
    // Create real event bus
    eventBus = createEventBus();
    capturedEvents = [];

    // Mock HAL
    mockHal = {
      writeControlCalls: [],
      readMeterResult: { gridPower: 0 },
      async writeControl(target, value) {
        mockHal.writeControlCalls.push({ target, value });
      },
      async readMeter() {
        return mockHal.readMeterResult;
      }
    };

    // Mock DB
    mockDb = {
      insertControlEventCalls: [],
      async insertControlEvent(event) {
        mockDb.insertControlEventCalls.push(event);
      }
    };

    // Create real arbitrator and executor
    arbitrator = createArbitrator();
    executor = createExecutor({
      hal: mockHal,
      db: mockDb,
      eventBus,
      config: { readbackDelayMs: 0 }
    });

    // Capture exec:deviation events
    eventBus.on$('exec:deviation').subscribe(e => capturedEvents.push(e));

    // Wire the subscription (simulates exec module index.js flow)
    intentSub = eventBus.on$('control:intent').subscribe(intent => {
      if (intent.action === 'clear' && intent.source) {
        arbitrator.clearSource(intent.source);
        return;
      }

      const result = arbitrator.submitIntent(intent);

      for (const target of result.applied) {
        executor.executeCommand({
          source: intent.source,
          priority: intent.priority,
          target,
          value: intent.targets[target],
          reason: intent.reason
        }).catch(() => {});
      }
    });
  });

  function cleanup() {
    if (intentSub) intentSub.unsubscribe();
    eventBus.destroy();
  }

  it('EXEC-02: all writes go through executor (writeControl called via executor)', async () => {
    // Emit a control:intent event
    eventBus.emit({
      type: 'control:intent',
      source: 'dv',
      priority: 2,
      action: 'set',
      targets: { feedExcessDcPv: true },
      reason: 'test_release',
      timestamp: Date.now()
    });

    // Allow async executor to complete
    await new Promise(r => setTimeout(r, 20));

    // Verify HAL was called (through executor, not directly)
    assert.equal(mockHal.writeControlCalls.length, 1, 'HAL writeControl should be called once');
    assert.equal(mockHal.writeControlCalls[0].target, 'feedExcessDcPv');
    assert.equal(mockHal.writeControlCalls[0].value, true);

    // Verify DB command:sent was logged
    const sentEvents = mockDb.insertControlEventCalls.filter(e => e.type === 'command:sent');
    assert.equal(sentEvents.length, 1, 'command:sent should be logged to DB');

    cleanup();
  });

  it('EXEC-01: DV priority 2 wins over optimizer priority 4 for same target', async () => {
    // First: DV intent (priority 2) for gridSetpointW
    eventBus.emit({
      type: 'control:intent',
      source: 'dv',
      priority: 2,
      action: 'set',
      targets: { feedExcessDcPv: false },
      reason: 'dv_curtail',
      timestamp: Date.now()
    });

    await new Promise(r => setTimeout(r, 20));

    // Then: optimizer intent (priority 4) for same target
    eventBus.emit({
      type: 'control:intent',
      source: 'optimizer',
      priority: 4,
      action: 'set',
      targets: { feedExcessDcPv: true },
      reason: 'optimizer_release',
      timestamp: Date.now()
    });

    await new Promise(r => setTimeout(r, 20));

    // Only DV value should have been written to HAL (optimizer was overridden)
    assert.equal(mockHal.writeControlCalls.length, 1, 'Only DV should write to HAL');
    assert.equal(mockHal.writeControlCalls[0].value, false, 'DV curtail value should win');

    // Arbitrator should show the optimizer as overridden
    const overridden = arbitrator.getOverridden();
    assert.ok(overridden.length >= 1, 'Should have at least one overridden entry');
    const optOverride = overridden.find(o => o.source === 'optimizer');
    assert.ok(optOverride, 'Optimizer intent should be overridden');
    assert.equal(optOverride.overriddenBy, 'dv');

    cleanup();
  });

  it('EXEC-04: deviation alert fires when readback exceeds threshold', async () => {
    // Configure readback: commanding gridSetpointW=-40 but reading gridPower=1000
    mockHal.readMeterResult = { gridPower: 1000 };

    eventBus.emit({
      type: 'control:intent',
      source: 'manual',
      priority: 3,
      action: 'set',
      targets: { gridSetpointW: -40 },
      reason: 'test_deviation',
      timestamp: Date.now()
    });

    // Wait for async execution + readback
    await new Promise(r => setTimeout(r, 50));

    // Verify exec:deviation event was emitted
    assert.ok(capturedEvents.length >= 1, 'Should have captured exec:deviation event');
    const devEvent = capturedEvents.find(e => e.type === 'exec:deviation');
    assert.ok(devEvent, 'exec:deviation event should exist');
    assert.equal(devEvent.target, 'gridSetpointW');
    assert.equal(devEvent.commanded, -40);
    assert.equal(devEvent.readback, 1000);
    assert.equal(devEvent.deviation, 1040);

    // Verify DB logged the deviation
    const devDbEvents = mockDb.insertControlEventCalls.filter(e => e.type === 'command:deviation');
    assert.ok(devDbEvents.length >= 1, 'command:deviation should be logged to DB');

    cleanup();
  });

  it('EXEC-02: HAL writeControl count matches executor command count', async () => {
    // Emit multiple intents for different targets
    eventBus.emit({
      type: 'control:intent',
      source: 'dv',
      priority: 2,
      action: 'set',
      targets: { feedExcessDcPv: true, dontFeedExcessAcPv: false },
      reason: 'test_multi',
      timestamp: Date.now()
    });

    await new Promise(r => setTimeout(r, 30));

    // Two targets should result in two writeControl calls
    assert.equal(mockHal.writeControlCalls.length, 2, 'Two targets = two writeControl calls');

    // Command log should also have 2 entries
    const log = executor.getCommandLog();
    assert.equal(log.length, 2, 'Command log should have 2 entries');

    // writeControl calls and command log entries should match
    assert.equal(
      mockHal.writeControlCalls.length,
      log.length,
      'HAL write count must equal executor command count'
    );

    cleanup();
  });

  it('clear action removes source intents from arbitrator', async () => {
    // First set an optimizer intent
    eventBus.emit({
      type: 'control:intent',
      source: 'optimizer',
      priority: 4,
      action: 'set',
      targets: { gridSetpointW: -500 },
      reason: 'plan_slot',
      timestamp: Date.now()
    });

    await new Promise(r => setTimeout(r, 20));

    // Verify it was applied
    assert.ok(arbitrator.resolve('gridSetpointW'), 'gridSetpointW should have active intent');

    // Now clear optimizer intents
    eventBus.emit({
      type: 'control:intent',
      source: 'optimizer',
      priority: 4,
      action: 'clear',
      targets: {},
      reason: 'plan_cleared',
      timestamp: Date.now()
    });

    await new Promise(r => setTimeout(r, 20));

    // Intent should be cleared
    assert.equal(arbitrator.resolve('gridSetpointW'), null, 'gridSetpointW should be cleared');

    cleanup();
  });
});
