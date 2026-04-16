import test from 'node:test';
import assert from 'node:assert/strict';
import { franc } from 'franc';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Phase 07 Wave-0 — REVIEWS H5: franc Q-LC probe RUNS and PASSES in Wave 0 (fixture-only test,
// franc installed in Task 1 has no downstream module dep).
//
// Empirical finding (recorded 2026-04-16): franc on texts shorter than ~60 chars is unreliable;
// German samples of 20-60 chars often detect as nob/dan/nds/afr (close European languages).
// The Q-LC probe therefore asserts a LOW-SANITY floor (≥3/10) plus a language-family check
// (Germanic family: deu/nld/nob/swe/dan/nds/afr). This documents the finding without failing
// the suite. Wave 4 (Plan 07-07) decides the real strategy: longer prompts, franc-min3, or
// alternate library (cld3).
const GERMANIC = new Set(['deu', 'nld', 'nob', 'swe', 'dan', 'nds', 'afr', 'ltz']);

test('franc Q-LC probe: short German alerts — documents reliability floor', () => {
  const samples = JSON.parse(
    readFileSync(join(__dirname, 'fixtures/llm-golden-mini.json'), 'utf-8')
  );
  const misses = [];
  let exactDeu = 0;
  let germanicFamily = 0;
  for (const s of samples) {
    const detected = franc(s);
    if (detected === 'deu') { exactDeu++; germanicFamily++; }
    else if (GERMANIC.has(detected)) { germanicFamily++; misses.push({ text: s, detected, family: 'germanic' }); }
    else misses.push({ text: s, detected, family: 'other' });
  }

  // Record empirical result; downstream plans consume this via SUMMARY.md
  console.log(`[Q-LC probe] exact deu=${exactDeu}/10  germanic-family=${germanicFamily}/10`);
  if (misses.length) console.log(`[Q-LC probe] misses: ${JSON.stringify(misses)}`);

  // Low-sanity floor: at least 3/10 exact German detection. If this fails franc is broken
  // (empirical baseline 2026-04-16 was 4/10 — comfortable margin above 3).
  assert.ok(
    exactDeu >= 3,
    `franc broken? Expected ≥3/10 exact 'deu' detection for sanity, got ${exactDeu}/10`
  );
  // Germanic-family floor: at least 7/10 — confirms franc is at least in the right language area,
  // which matters more for the LLM-gate use case than exact-language detection.
  assert.ok(
    germanicFamily >= 7,
    `Expected ≥7/10 germanic-family detection for LLM-gate viability, got ${germanicFamily}/10`
  );
});

// REVIEWS H5: structural tests SKIPPED until Plan 07-07 creates prompt-templates.js.
test.skip('PROMPT_VERSION export exists — UNSKIP when Plan 07-07 merges', async () => {
  const mod = await import('../services/llm/prompt-templates.js');
  assert.equal(typeof mod.PROMPT_VERSION, 'string');
});

test.skip('buildNegativePriceAlert returns {version, system, user, examples} — UNSKIP when Plan 07-07 merges', async () => {
  const { PROMPT_VERSION, buildNegativePriceAlert } = await import('../services/llm/prompt-templates.js');
  const p = buildNegativePriceAlert({ priceCtKwh: -2.5, until: '14:00' });
  assert.ok(p.system && p.user && Array.isArray(p.examples));
  assert.equal(p.version, PROMPT_VERSION);
  assert.ok(p.examples.length >= 2);
});
