import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDvState } from '../modules/dv/dv-state.js';
import { createLuoxProvider } from '../modules/dv/providers/luox.js';
import { PROVIDER_INTERFACE } from '../modules/dv/providers/provider-interface.js';

/** u16 reference for test assertions */
function u16(v) {
  let x = Math.trunc(Number(v) || 0);
  if (x < 0) x += 0x10000;
  return x & 0xffff;
}

describe('createDvState', () => {
  it('returns object with dvRegs, ctrl, keepalive defaults', () => {
    const s = createDvState();
    assert.deepStrictEqual(s.dvRegs, { 0: 0, 1: 0, 3: 0, 4: 0 });
    assert.deepStrictEqual(s.ctrl, {
      forcedOff: false,
      offUntil: 0,
      lastSignal: null,
      updatedAt: 0,
      dvControl: null
    });
    assert.deepStrictEqual(s.keepalive, { modbusLastQuery: null });
  });

  it('setReg/getReg round-trips values', () => {
    const s = createDvState();
    s.setReg(0, 1000);
    assert.strictEqual(s.dvRegs[0], 1000);
    assert.strictEqual(s.getReg(0), 1000);
  });

  it('setReg clamps negative to u16', () => {
    const s = createDvState();
    s.setReg(0, -500);
    assert.strictEqual(s.getReg(0), u16(-500));
    assert.strictEqual(s.getReg(0), 65036);
  });

  it('setReg clamps overflow to u16', () => {
    const s = createDvState();
    s.setReg(0, 70000);
    assert.strictEqual(s.getReg(0), u16(70000));
    assert.strictEqual(s.getReg(0), 4464);
  });

  it('getReg returns 0 for unset addresses', () => {
    const s = createDvState();
    assert.strictEqual(s.getReg(99), 0);
  });
});

describe('PROVIDER_INTERFACE', () => {
  it('documents expected provider shape', () => {
    assert.ok(PROVIDER_INTERFACE);
    assert.strictEqual(typeof PROVIDER_INTERFACE.name, 'string');
    assert.strictEqual(typeof PROVIDER_INTERFACE.registerLayout, 'string');
    assert.strictEqual(typeof PROVIDER_INTERFACE.interpretWrite, 'string');
    assert.strictEqual(typeof PROVIDER_INTERFACE.formatRegisters, 'string');
  });
});

describe('createLuoxProvider', () => {
  it('returns object with name=luox and required methods', () => {
    const p = createLuoxProvider();
    assert.strictEqual(p.name, 'luox');
    assert.ok(p.registerLayout);
    assert.strictEqual(typeof p.interpretWrite, 'function');
    assert.strictEqual(typeof p.formatRegisters, 'function');
  });

  describe('interpretWrite', () => {
    it('addr 0 [0,0] => curtail', () => {
      const p = createLuoxProvider();
      const r = p.interpretWrite(0, [0, 0]);
      assert.deepStrictEqual(r, { action: 'curtail', reason: 'fc16_addr0_0000' });
    });

    it('addr 0 [0xffff,0xffff] => release', () => {
      const p = createLuoxProvider();
      const r = p.interpretWrite(0, [0xffff, 0xffff]);
      assert.deepStrictEqual(r, { action: 'release', reason: 'fc16_addr0_ffff' });
    });

    it('addr 3 [1] => curtail', () => {
      const p = createLuoxProvider();
      const r = p.interpretWrite(3, [1]);
      assert.deepStrictEqual(r, { action: 'curtail', reason: 'fc16_addr3_0001' });
    });

    it('addr 3 [0] => release', () => {
      const p = createLuoxProvider();
      const r = p.interpretWrite(3, [0]);
      assert.deepStrictEqual(r, { action: 'release', reason: 'fc16_addr3_0000' });
    });

    it('addr 5 [1] => null (unknown address)', () => {
      const p = createLuoxProvider();
      const r = p.interpretWrite(5, [1]);
      assert.strictEqual(r, null);
    });
  });

  describe('formatRegisters', () => {
    it('positive grid_total_w maps to register 0', () => {
      const p = createLuoxProvider();
      const r = p.formatRegisters({ grid_total_w: 1500 });
      assert.deepStrictEqual(r, { 0: 1500, 1: 0, 3: 0, 4: 0 });
    });

    it('negative grid_total_w uses u16 and sets sign word', () => {
      const p = createLuoxProvider();
      const r = p.formatRegisters({ grid_total_w: -800 });
      assert.deepStrictEqual(r, { 0: u16(-800), 1: 0xffff, 3: 0, 4: 0 });
    });

    it('empty input defaults to all zeros', () => {
      const p = createLuoxProvider();
      const r = p.formatRegisters({});
      assert.deepStrictEqual(r, { 0: 0, 1: 0, 3: 0, 4: 0 });
    });
  });
});
