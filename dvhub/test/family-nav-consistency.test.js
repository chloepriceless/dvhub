// test/family-nav-consistency.test.js -- Enforces Plan 03-03 + D-02:
// every non-family public page has "Familie" as the 2nd nav link, and
// family.html itself has NO topbar (Kiosk feel).
// Phase 8 Plan 10 reduced tools.html to a meta-refresh stub, so it no
// longer participates in nav consistency checks.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const NAV_FILES = ['index.html', 'settings.html', 'history.html'];

function readNavBlock(file) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  const match = html.match(/<nav[^>]*class="topbar-nav"[^>]*>([\s\S]*?)<\/nav>/);
  return match ? match[1] : null;
}

describe('family nav link consistency (D-02)', () => {
  for (const file of NAV_FILES) {
    it(`${file} contains <a href="/family">Familie</a> inside topbar-nav`, () => {
      const navBlock = readNavBlock(file);
      assert.ok(navBlock, `${file}: no topbar-nav block found`);
      assert.ok(
        /<a[^>]*href=["']\/family["'][^>]*>\s*Familie\s*<\/a>/.test(navBlock),
        `${file}: missing <a href="/family">Familie</a> in topbar-nav. Block was:\n${navBlock}`
      );
    });
  }

  it('family.html does NOT have a topbar-nav (D-02 Kiosk feel)', () => {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'family.html'), 'utf8');
    assert.ok(!html.includes('topbar-nav'), 'family.html must not have topbar-nav');
  });

  it('"Familie" link is the 2nd nav entry (immediately after Leitstand)', () => {
    for (const file of NAV_FILES) {
      const navBlock = readNavBlock(file);
      assert.ok(navBlock, `${file}: no topbar-nav block`);
      const links = [...navBlock.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/g)]
        .map((m) => ({ href: m[1].trim(), text: m[2].trim() }));
      assert.ok(links.length >= 2, `${file}: needs at least 2 nav links`);
      assert.equal(links[1].href, '/family', `${file}: 2nd link should be /family, got ${links[1].href}`);
      assert.equal(links[1].text, 'Familie', `${file}: 2nd link text should be "Familie", got "${links[1].text}"`);
    }
  });
});
