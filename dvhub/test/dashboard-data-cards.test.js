import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCentFromCt,
  formatCentFromTenthCt,
  resolveDvControlIndicators,
  computeCostColor,
  formatTimestamp
} from '../public/components/dashboard/dashboard-compute.js';

// --- formatCentFromCt ---

test('formatCentFromCt formats cents with German locale', () => {
  const result = formatCentFromCt(12.345);
  assert.ok(result.includes('12'), `Expected "12" in "${result}"`);
  assert.ok(result.includes('Cent'), `Expected "Cent" in "${result}"`);
});

test('formatCentFromCt returns dash for null', () => {
  assert.equal(formatCentFromCt(null), '-');
});

test('formatCentFromCt returns dash for undefined', () => {
  assert.equal(formatCentFromCt(undefined), '-');
});

// --- formatCentFromTenthCt ---

test('formatCentFromTenthCt divides by 10 and formats', () => {
  const result = formatCentFromTenthCt(123);
  assert.ok(result.includes('12'), `Expected "12" in "${result}"`);
  assert.ok(result.includes('Cent'), `Expected "Cent" in "${result}"`);
});

// --- resolveDvControlIndicators with Victron readback ---

test('resolveDvControlIndicators with victron readback DC=1 AC=0', () => {
  const result = resolveDvControlIndicators({
    victron: { feedExcessDcPv: 1, dontFeedExcessAcPv: 0 }
  });
  assert.equal(result.dc.text, 'EIN');
  assert.equal(result.dc.tone, 'ok');
  assert.equal(result.ac.text, 'Nein');
  assert.equal(result.ac.tone, 'ok');
});

// --- resolveDvControlIndicators with dvControl fallback ---

test('resolveDvControlIndicators falls back to dvControl when victron null', () => {
  const result = resolveDvControlIndicators({
    victron: { feedExcessDcPv: null, dontFeedExcessAcPv: null },
    ctrl: {
      dvControl: {
        feedExcessDcPv: { ok: true },
        dontFeedExcessAcPv: { ok: true },
        feedIn: true
      }
    }
  });
  assert.equal(result.dc.text, 'EIN');
  assert.equal(result.dc.tone, 'ok');
  assert.equal(result.ac.text, 'Nein');
  assert.equal(result.ac.tone, 'ok');
});

// --- resolveDvControlIndicators with empty status ---

test('resolveDvControlIndicators returns dashes for empty status', () => {
  const result = resolveDvControlIndicators({});
  assert.equal(result.dc.text, '-');
  assert.equal(result.ac.text, '-');
  assert.equal(result.dc.tone, undefined);
  assert.equal(result.ac.tone, undefined);
});

// --- computeCostColor ---

test('computeCostColor returns green for positive net', () => {
  assert.equal(computeCostColor(5), 'var(--dvhub-green)');
});

test('computeCostColor returns red for negative net', () => {
  assert.equal(computeCostColor(-3), 'var(--dvhub-red)');
});

test('computeCostColor returns muted for null', () => {
  assert.equal(computeCostColor(null), 'var(--text-muted)');
});

// --- formatTimestamp ---

test('formatTimestamp returns formatted date for ISO string', () => {
  // Use a fixed date to avoid timezone issues
  const result = formatTimestamp('2026-03-14T14:30:00Z');
  assert.ok(result.includes('14') || result.includes('15'), `Expected day in "${result}"`);
  assert.ok(result !== '--', 'Should not be fallback');
});

test('formatTimestamp returns dash for falsy input', () => {
  assert.equal(formatTimestamp(null), '--');
  assert.equal(formatTimestamp(''), '--');
  assert.equal(formatTimestamp(0), '--');
});
