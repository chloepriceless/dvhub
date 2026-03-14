import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const componentsDir = resolve(__dirname, '..', 'public', 'components');

describe('history-chart.js', () => {
  const content = readFileSync(resolve(componentsDir, 'history', 'history-chart.js'), 'utf-8');

  it('exports HistoryChart', () => {
    assert.ok(content.includes('export function HistoryChart'), 'should export HistoryChart');
  });

  it('contains viewBox (SVG chart)', () => {
    assert.ok(content.includes('viewBox'), 'should use SVG viewBox');
  });
});

describe('history-page.js', () => {
  const content = readFileSync(resolve(componentsDir, 'history', 'history-page.js'), 'utf-8');

  it('exports HistoryPage', () => {
    assert.ok(content.includes('export function HistoryPage'), 'should export HistoryPage');
  });

  it('references /api/history/summary', () => {
    assert.ok(content.includes('/api/history/summary'), 'should fetch from /api/history/summary');
  });

  it('references Heute preset', () => {
    assert.ok(content.includes('Heute'), 'should have Heute preset button');
  });

  it('references 7 Tage preset', () => {
    assert.ok(content.includes('7 Tage'), 'should have 7 Tage preset button');
  });

  it('references /api/history/backfill', () => {
    assert.ok(content.includes('/api/history/backfill'), 'should reference VRM backfill endpoint');
  });
});

describe('tools-page.js', () => {
  const content = readFileSync(resolve(componentsDir, 'tools', 'tools-page.js'), 'utf-8');

  it('exports ToolsPage', () => {
    assert.ok(content.includes('export function ToolsPage'), 'should export ToolsPage');
  });

  it('references /api/admin/health', () => {
    assert.ok(content.includes('/api/admin/health'), 'should fetch health endpoint');
  });

  it('references /api/version', () => {
    assert.ok(content.includes('/api/version'), 'should fetch version endpoint');
  });
});
