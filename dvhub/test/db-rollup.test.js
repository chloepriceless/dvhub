import { describe, it } from 'node:test';

describe('Rollup Engine', () => {

  it('5-min rollup produces correct avg/min/max/count', { todo: true }, () => {
    // Will verify: raw samples aggregated into 5min bucket with correct statistics
  });

  it('15-min rollup uses weighted average via sample_count', { todo: true }, () => {
    // Will verify: 15min rollup from 5min uses SUM(avg*count)/SUM(count), not AVG(AVG)
  });

  it('daily rollup aggregates from 15-min data', { todo: true }, () => {
    // Will verify: daily rollup reads from telemetry_15min, not raw
  });

  it('rollup with no data is a no-op', { todo: true }, () => {
    // Will verify: runRollups() with empty tables returns { rolledUp: 0 }
  });

});
