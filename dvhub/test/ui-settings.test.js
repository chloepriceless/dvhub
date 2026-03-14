import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const componentsDir = resolve(__dirname, '..', 'public', 'components');

describe('settings-page.js exports', () => {
  const content = readFileSync(resolve(componentsDir, 'settings', 'settings-page.js'), 'utf-8');

  it('exports SettingsPage', () => {
    assert.ok(content.includes('export function SettingsPage'), 'should export SettingsPage');
  });

  it('references /api/config', () => {
    assert.ok(content.includes('/api/config'), 'should fetch from /api/config');
  });

  const expectedSections = ['System', 'Hersteller', 'DV-Modul', 'Optimierung', 'Boersenpreise', 'Tarifsystem', 'PV-Anlagen', 'Netzwerk', 'Datenbank'];

  for (const section of expectedSections) {
    it(`contains section "${section}"`, () => {
      assert.ok(content.includes(section), `should reference section ${section}`);
    });
  }
});

describe('settings-field.js exports', () => {
  const content = readFileSync(resolve(componentsDir, 'settings', 'settings-field.js'), 'utf-8');

  it('exports SettingsField', () => {
    assert.ok(content.includes('export function SettingsField'), 'should export SettingsField');
  });
});

describe('settings-section.js exports', () => {
  const content = readFileSync(resolve(componentsDir, 'settings', 'settings-section.js'), 'utf-8');

  it('exports SettingsSection', () => {
    assert.ok(content.includes('export function SettingsSection'), 'should export SettingsSection');
  });
});
