#!/usr/bin/env node
// scripts/diagnose-load-forecast.js
//
// Phase 07 Wave-0 diagnostic — resolves RESEARCH Open-Question Q-SF (StatsForecast flat-800W root cause).
//
// Pulls the last N days of load history from energy_slots_15m, feeds the EXACT same input shape
// the production pipeline (services/forecast/load-forecast.js lines 98-110 + Python bridge at 167-172)
// feeds load_forecast_sf.py, and captures both input-side signals (std_power, gaps_over_1h) and
// output-side signals (SF min/max/std/is_flat).
//
// Decision rule (RESEARCH §Open Questions Q-SF lines 1031-1033):
//   - sf_result_summary.std < 5W  AND  std_power > 100W   → root cause confirmed = SF-1 (frequency mismatch).
//         Wave 3 Plan 06 can proceed with Pattern 3 fix.
//   - sf_result_summary.std >= 5W → SF-1 is NOT the root cause; investigate data quality + defaultPowerW fallback.
//
// Usage:
//   node scripts/diagnose-load-forecast.js [--days=30] [--out=/tmp/lf-diag.json]
//
// Requires:
//   - $DATABASE_URL env var (pg connection string) OR local DB reachable via default pg env vars
//   - python3 in PATH (for services/python-bridge/scripts/load_forecast_sf.py)

import { writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SF_SCRIPT = path.join(REPO_ROOT, 'services', 'python-bridge', 'scripts', 'load_forecast_sf.py');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { days: 30, out: '/tmp/lf-diag.json' };
  for (const a of args) {
    if (a.startsWith('--days=')) out.days = Number(a.slice('--days='.length)) || 30;
    else if (a.startsWith('--out=')) out.out = a.slice('--out='.length);
  }
  return out;
}

function summariseHistory(rows) {
  if (!rows.length) {
    return {
      history_rows_count: 0,
      first_ts: null,
      last_ts: null,
      min_power: null, max_power: null, mean_power: null, std_power: null,
      gaps_over_1h: 0
    };
  }
  const powers = rows.map(r => Number(r.power_w));
  const min_power = Math.min(...powers);
  const max_power = Math.max(...powers);
  const mean_power = powers.reduce((a, b) => a + b, 0) / powers.length;
  const variance = powers.reduce((s, p) => s + (p - mean_power) ** 2, 0) / powers.length;
  const std_power = Math.sqrt(variance);

  // Gaps: consecutive rows with delta > 1h
  let gaps_over_1h = 0;
  for (let i = 1; i < rows.length; i++) {
    const prev = new Date(rows[i - 1].ts_utc).getTime();
    const curr = new Date(rows[i].ts_utc).getTime();
    if (curr - prev > 3600 * 1000) gaps_over_1h++;
  }

  return {
    history_rows_count: rows.length,
    first_ts: rows[0].ts_utc,
    last_ts: rows[rows.length - 1].ts_utc,
    min_power: Math.round(min_power * 100) / 100,
    max_power: Math.round(max_power * 100) / 100,
    mean_power: Math.round(mean_power * 100) / 100,
    std_power: Math.round(std_power * 100) / 100,
    gaps_over_1h
  };
}

function invokeSf(history) {
  return new Promise((resolve) => {
    const child = execFile('python3', [SF_SCRIPT], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: err.message, stderr: (stderr || '').slice(-500) });
        return;
      }
      try {
        resolve({ ok: true, result: JSON.parse(stdout) });
      } catch (e) {
        resolve({ ok: false, error: 'parse_error: ' + e.message, stdout: (stdout || '').slice(-500) });
      }
    });
    child.stdin.write(JSON.stringify({ history, horizon: 72 }));
    child.stdin.end();
  });
}

function summariseSf(sfResponse) {
  if (!sfResponse.ok) return { error: sfResponse.error, stderr: sfResponse.stderr ?? null };
  const res = sfResponse.result;
  if (!Array.isArray(res)) return { error: 'unexpected_shape', sample: JSON.stringify(res).slice(0, 200) };
  const powers = res.map(r => Number(r.power_w));
  if (!powers.length) return { horizon: 0, min: null, max: null, std: null, is_flat: null };
  const min = Math.min(...powers);
  const max = Math.max(...powers);
  const mean = powers.reduce((a, b) => a + b, 0) / powers.length;
  const std = Math.sqrt(powers.reduce((s, p) => s + (p - mean) ** 2, 0) / powers.length);
  return {
    horizon: res.length,
    min: Math.round(min * 100) / 100,
    max: Math.round(max * 100) / 100,
    std: Math.round(std * 100) / 100,
    is_flat: std < 5
  };
}

async function main() {
  const args = parseArgs();
  const report = {
    args,
    generated_at: new Date().toISOString(),
    db_connected: false,
    history_rows_count: 0,
    std_power: null,
    gaps_over_1h: 0,
    sf_input_rows_after_current_pipeline: 0,
    sf_result_summary: null,
    errors: []
  };

  // Mirror load-forecast.js queryLoadHistory pattern; use same series_key=load_power_w source_kind=live.
  let rows = [];
  try {
    const pool = new pg.Pool();
    const result = await pool.query(`
      SELECT slot_start_utc AS ts_utc, value_num AS power_w
      FROM energy_slots_15m
      WHERE series_key = 'load_power_w'
        AND source_kind = 'live'
        AND slot_start_utc >= NOW() - ($1 || ' days')::INTERVAL
      ORDER BY slot_start_utc ASC
    `, [String(args.days)]);
    rows = result.rows.map(r => ({
      ts_utc: r.ts_utc instanceof Date ? r.ts_utc.toISOString() : String(r.ts_utc),
      power_w: Number(r.power_w)
    }));
    report.db_connected = true;
    await pool.end();
  } catch (e) {
    report.errors.push({ stage: 'db_query', error: e.message });
  }

  const histSum = summariseHistory(rows);
  Object.assign(report, histSum);
  report.sf_input_rows_after_current_pipeline = rows.length;

  // Invoke SF only if we have enough history (mirror production 48-row minimum check)
  if (rows.length >= 48) {
    const sfResp = await invokeSf(rows);
    report.sf_result_summary = summariseSf(sfResp);
    if (!sfResp.ok) report.errors.push({ stage: 'sf_invoke', error: sfResp.error, stderr: sfResp.stderr });
  } else {
    report.sf_result_summary = { skipped: true, reason: `insufficient_history (${rows.length} rows < 48)` };
  }

  writeFileSync(args.out, JSON.stringify(report, null, 2));

  // Summary print
  console.log('--- diagnose-load-forecast ---');
  console.log(`history_rows_count = ${report.history_rows_count}`);
  console.log(`std_power          = ${report.std_power}W`);
  console.log(`gaps_over_1h       = ${report.gaps_over_1h}`);
  console.log(`sf_result_summary  = ${JSON.stringify(report.sf_result_summary)}`);
  console.log('');
  console.log('--- Decision Rule (Q-SF) ---');
  if (report.sf_result_summary && report.sf_result_summary.is_flat === true && report.std_power > 100) {
    console.log('VERDICT: SF-1 CONFIRMED (flat output despite variable input) → Wave 3 Pattern 3 fix applies.');
  } else if (report.sf_result_summary && report.sf_result_summary.is_flat === false) {
    console.log('VERDICT: SF-1 NOT present in this sample (SF output is dynamic).');
  } else {
    console.log('VERDICT: Inconclusive (see errors/skip reason).');
  }
  console.log(`Output: ${args.out}`);
}

main().catch(e => {
  console.error('diagnose-load-forecast crashed:', e.message);
  process.exit(1);
});
