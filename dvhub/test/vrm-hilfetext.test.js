// test/vrm-hilfetext.test.js — Issue #32 (stefan-12, nach 1.0.9): Hilfetext zum
// VRM-Feld. Bei mehreren Anlagen im VRM-Konto ist die Site-ID der sichere Weg;
// mit der Portal-ID sucht DVhub die passende Anlage selbst.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getConfigDefinition } from '../config-model.js';

const decode = (s) => s.replace(/&uuml;/g, 'ü').replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö').replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, '');

test('Integrationen → VRM-Cloud: Hinweis nennt die Site-ID als sicheren Weg bei mehreren Anlagen', () => {
  const html = fs.readFileSync(new URL('../public/integrations.html', import.meta.url), 'utf8');
  const label = html.indexOf('VRM-Portal-ID oder Site-ID');
  assert.ok(label > 0);
  const hint = decode(/<span class="field-hint">([\s\S]*?)<\/span>/.exec(html.slice(label))?.[1] || '');
  assert.match(hint, /mehreren Anlagen im VRM-Konto ist die Site-ID der sichere Weg/);
  assert.match(hint, /Portal-ID sucht DVhub die passende Anlage selbst/);
});

test('Einstellungen → Historie-Import: derselbe Hinweis am Feld telemetry.historyImport.vrmPortalId', () => {
  const def = getConfigDefinition();
  const fields = def.fields || [];
  const f = fields.find((x) => x.path === 'telemetry.historyImport.vrmPortalId');
  assert.ok(f, 'Feld vorhanden');
  assert.match(f.help, /mehreren Anlagen im VRM-Konto ist die Site-ID der sichere Weg/);
  assert.match(f.help, /Portal-ID sucht DVhub die passende Anlage selbst/);
});
