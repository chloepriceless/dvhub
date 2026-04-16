#!/usr/bin/env node
// scripts/probe-pvnode-headers.js
//
// Phase 07 Wave-0 diagnostic — resolves RESEARCH Open-Question Q-P1 (pvnode 2-plane response shape)
// and confirms rate-limit header structure (supports D-A5 client-side quota decision).
//
// Purpose: empirically compare pvnode's 1-plane vs 2-plane responses so Wave 1 (Plan 07-02) can write
// multi-plane client code against the real API contract instead of hypothetical aggregation.
//
// Decision rule (RESEARCH §Open Questions Q-P1 lines 1005-1010):
//   - 2plane.bodySize / 1plane.bodySize ≈ 1.0 → aggregated response;
//       Wave 1 still needs client-side slot-merge across GROUPS (chunks of 2 plants each).
//   - 2plane.bodySize / 1plane.bodySize ≈ 2.0 → per-plane arrays in the 2-plane response;
//       Wave 1 additionally merges WITHIN a group.
//   Pattern 1 code uses a Map-based slot-merge that handles both cases identically.
//
// Security:
//   - Bearer token is read from cfg.forecast.pvnode.apiKey; NEVER logged/printed.
//   - Output files written to /tmp (user-owned). STDOUT shows sizes/shape, not header value.
//   - Script makes exactly 2 outbound calls (1-plane + 2-plane) = 2 quota units of 1000-3000/mo.
//
// Usage:
//   node scripts/probe-pvnode-headers.js [--config=<path>]
//
// Outputs:
//   /tmp/pvnode-1plane.json  -- {status, headers, bodySize, body}
//   /tmp/pvnode-2plane.json  -- {status, headers, bodySize, body}
//   test/fixtures/pvnode-response.json  -- 2-plane body (fixture for Wave 1 tests)

import { writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigFile } from '../config-model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { config: path.join(REPO_ROOT, 'config.json') };
  for (const a of args) {
    if (a.startsWith('--config=')) out.config = a.slice('--config='.length);
  }
  return out;
}

function resolveLocation(cfg) {
  const fc = cfg?.forecast || {};
  const lat = fc.location?.latitude
    ?? cfg?.schedule?.smallMarketAutomation?.location?.latitude
    ?? cfg?.site?.latitude;
  const lon = fc.location?.longitude
    ?? cfg?.schedule?.smallMarketAutomation?.location?.longitude
    ?? cfg?.site?.longitude;
  return {
    lat: Number.isFinite(lat) ? lat : 52.52,
    lon: Number.isFinite(lon) ? lon : 13.405
  };
}

function buildUrl({ lat, lon, twoPlane }) {
  const base = 'https://api.pvnode.com/v1/forecast/';
  const p = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    slope: '30',
    orientation: '180',
    pv_power_kw: '5',
    forecast_days: '1',
    nowcast: 'false',
    required_data: 'spec_watts,temp'
  });
  if (twoPlane) {
    p.append('second_array_slope', '30');
    p.append('second_array_orientation', '270');
    p.append('second_array_power_kw', '3');
  }
  return `${base}?${p.toString()}`;
}

function detectBodyShape(body) {
  if (!body || typeof body !== 'object') return { keys: [], hasArrays: false, hasPlanes: false };
  const keys = Object.keys(body);
  const hasArrays = 'arrays' in body || 'plane_arrays' in body;
  const hasPlanes = 'planes' in body || 'pv_planes' in body;
  return { keys, hasArrays, hasPlanes };
}

async function probe({ url, apiKey, label }) {
  let status = null;
  let headers = {};
  let bodyText = '';
  let body = null;
  let error = null;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(20000)
    });
    status = res.status;
    headers = Object.fromEntries([...res.headers.entries()]);
    bodyText = await res.text();
    try { body = bodyText ? JSON.parse(bodyText) : null; } catch { body = { _raw: bodyText.slice(0, 500) }; }
  } catch (e) {
    error = e.message;
  }

  const bodySize = Buffer.byteLength(bodyText || '', 'utf8');
  const shape = detectBodyShape(body);
  return { label, url, status, headers, bodySize, body, error, shape };
}

async function main() {
  const args = parseArgs();
  const { parsed: cfg } = loadConfigFile(args.config);
  const apiKey = cfg?.forecast?.pvnode?.apiKey;

  if (!apiKey) {
    console.error('ERROR: cfg.forecast.pvnode.apiKey is missing in ' + args.config);
    console.error('Probe refuses to run without API key (threat model T-07-01-02).');
    process.exit(2);
  }

  const { lat, lon } = resolveLocation(cfg);

  console.log(`[probe-pvnode-headers] lat=${lat} lon=${lon} (api key redacted)`);

  const url1 = buildUrl({ lat, lon, twoPlane: false });
  const url2 = buildUrl({ lat, lon, twoPlane: true });

  const r1 = await probe({ url: url1, apiKey, label: '1plane' });
  const r2 = await probe({ url: url2, apiKey, label: '2plane' });

  // Write /tmp files with 0600 perms (T-07-01-02 mitigation)
  const tmp1 = '/tmp/pvnode-1plane.json';
  const tmp2 = '/tmp/pvnode-2plane.json';
  writeFileSync(tmp1, JSON.stringify({ status: r1.status, headers: r1.headers, bodySize: r1.bodySize, body: r1.body, error: r1.error, attempted_url: r1.url }, null, 2));
  writeFileSync(tmp2, JSON.stringify({ status: r2.status, headers: r2.headers, bodySize: r2.bodySize, body: r2.body, error: r2.error, attempted_url: r2.url }, null, 2));
  try { chmodSync(tmp1, 0o600); chmodSync(tmp2, 0o600); } catch { /* best-effort on non-POSIX */ }

  // Update the fixture file from the 2-plane body if we got one
  const fixturePath = path.join(REPO_ROOT, 'test', 'fixtures', 'pvnode-response.json');
  if (r2.body && r2.status === 200) {
    writeFileSync(fixturePath, JSON.stringify(r2.body, null, 2));
    console.log(`[probe-pvnode-headers] Updated fixture: ${fixturePath}`);
  }

  // Summary
  const ratio = r1.bodySize > 0 ? (r2.bodySize / r1.bodySize).toFixed(3) : 'n/a';
  console.log('--- Probe Summary ---');
  console.log(`1-plane status=${r1.status} bodySize=${r1.bodySize} keys=${JSON.stringify(r1.shape.keys)} error=${r1.error ?? 'none'}`);
  console.log(`2-plane status=${r2.status} bodySize=${r2.bodySize} keys=${JSON.stringify(r2.shape.keys)} error=${r2.error ?? 'none'}`);
  console.log(`bodySize ratio (2plane/1plane) = ${ratio}`);
  console.log(`2-plane has 'arrays' field: ${r2.shape.hasArrays}  |  has 'planes' field: ${r2.shape.hasPlanes}`);
  console.log('--- Decision Rule (Q-P1) ---');
  console.log('ratio ≈ 1.0 → aggregated response; Wave 1 merges across GROUPS only.');
  console.log('ratio ≈ 2.0 → per-plane arrays; Wave 1 merges within groups too.');
  console.log(`Outputs: ${tmp1} ${tmp2}`);

  // Rate-limit header detection (supports D-A5 decision)
  const rlKeys = Object.keys(r1.headers).filter(k => /rate|quota|limit/i.test(k));
  if (rlKeys.length) {
    console.log(`Rate-limit-like headers detected: ${JSON.stringify(rlKeys)}`);
  } else {
    console.log('No rate-limit headers detected → D-A5 client-side counter is required (as planned).');
  }
}

main().catch(e => {
  console.error('Probe crashed:', e.message);
  process.exit(1);
});
