# DVhub Settings Navigation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure DVhub navigation and the settings experience so setup and maintenance are easier to understand, technical menus no longer dominate the default flow, and the settings layout becomes more compact without removing admin functionality.

**Architecture:** Keep the current vanilla HTML/CSS/JS shell and config-model driven settings renderer, but rename and regroup destinations in `config-model.js`, simplify the settings page markup, and repurpose the existing tools page into a maintenance hub. The implementation should preserve existing API behavior and rely on tests to lock down navigation structure, branding, and moved maintenance actions.

**Tech Stack:** Vanilla JavaScript, HTML, CSS, Node.js test runner (`node --test`)

---

### Task 1: Lock down the new top-level navigation and settings labels in tests

**Files:**
- Modify: `Plexlite/dv-control-webapp/test/branding.test.js`
- Modify: `Plexlite/dv-control-webapp/test/settings-shell.test.js`
- Modify: `Plexlite/dv-control-webapp/public/index.html`
- Modify: `Plexlite/dv-control-webapp/public/settings.html`
- Modify: `Plexlite/dv-control-webapp/public/setup.html`
- Modify: `Plexlite/dv-control-webapp/public/tools.html`

**Step 1: Write the failing tests**

```js
test('shell navigation uses Leitstand, Einrichtung, and Wartung labels', () => {
  for (const fileName of ['index.html', 'settings.html', 'setup.html', 'tools.html']) {
    const html = fs.readFileSync(path.join(publicDir, fileName), 'utf8');
    assert.match(html, /Leitstand/);
    assert.match(html, /Einrichtung/);
    assert.match(html, /Wartung/);
    assert.doesNotMatch(html, />Tools</);
  }
});

test('real config definition exposes compact task-oriented destination labels', () => {
  const labels = buildSettingsDestinations(getConfigDefinition())
    .filter((destination) => destination.kind !== 'overview')
    .map((destination) => destination.label);

  assert.deepEqual(labels, ['Schnellstart', 'Anlage verbinden', 'Steuerung', 'Preise & Daten', 'Erweitert']);
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Volumes/My\ Shared\ Files/CODEX/Plexlite/dv-control-webapp && node --test test/branding.test.js test/settings-shell.test.js`
Expected: FAIL because the current HTML still exposes `Tools`, `Setup`, `Einstellungen`, and the current destination labels.

**Step 3: Write minimal implementation**

```html
<a class="app-nav-link" href="/settings.html">Einrichtung</a>
<a class="app-nav-link" href="/tools.html">Wartung</a>
```

```js
{ id: 'quickstart', label: 'Schnellstart' }
```

**Step 4: Run test to verify it passes**

Run: `cd /Volumes/My\ Shared\ Files/CODEX/Plexlite/dv-control-webapp && node --test test/branding.test.js test/settings-shell.test.js`
Expected: PASS

### Task 2: Regroup the settings destinations and hide technical sections from the default navigation

**Files:**
- Modify: `Plexlite/dv-control-webapp/config-model.js`
- Modify: `Plexlite/dv-control-webapp/test/settings-shell.test.js`

**Step 1: Write the failing tests**

```js
test('real config definition maps technical sections into Erweitert instead of top-level navigation', () => {
  const definition = getConfigDefinition();
  const workspace = buildDestinationWorkspace(definition, 'advanced');

  assert.ok(workspace.sections.some((section) => section.id === 'points'));
  assert.ok(workspace.sections.some((section) => section.id === 'scan'));
  assert.ok(!buildSettingsDestinations(definition).some((destination) => destination.label === 'Lese-Register'));
  assert.ok(!buildSettingsDestinations(definition).some((destination) => destination.label === 'Scan Tool'));
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Volumes/My\ Shared\ Files/CODEX/Plexlite/dv-control-webapp && node --test test/settings-shell.test.js`
Expected: FAIL because the current destination model still uses the older grouped labels and raw technical taxonomy.

**Step 3: Write minimal implementation**

```js
const SETTINGS_DESTINATIONS = [
  { id: 'quickstart', label: 'Schnellstart' },
  { id: 'connection', label: 'Anlage verbinden' },
  { id: 'control', label: 'Steuerung' },
  { id: 'services', label: 'Preise & Daten' },
  { id: 'advanced', label: 'Erweitert' }
];
```

**Step 4: Run test to verify it passes**

Run: `cd /Volumes/My\ Shared\ Files/CODEX/Plexlite/dv-control-webapp && node --test test/settings-shell.test.js`
Expected: PASS

### Task 3: Replace the settings header with a compact control bar and a quickstart workspace

**Files:**
- Modify: `Plexlite/dv-control-webapp/public/settings.html`
- Modify: `Plexlite/dv-control-webapp/public/settings.js`
- Modify: `Plexlite/dv-control-webapp/public/styles.css`
- Modify: `Plexlite/dv-control-webapp/test/settings-shell.test.js`
- Modify: `Plexlite/dv-control-webapp/test/branding.test.js`

**Step 1: Write the failing tests**

```js
test('settings page uses a compact header and no longer renders the large service header cards', () => {
  const html = fs.readFileSync(path.join(publicDir, 'settings.html'), 'utf8');
  assert.match(html, /settings-compact-bar/);
  assert.doesNotMatch(html, /settings-service-panel/);
  assert.doesNotMatch(html, /Health &amp; Service/);
});

test('settings shell exposes Schnellstart as the default entry label', () => {
  const definition = getConfigDefinition();
  const destinations = buildSettingsDestinations(definition);
  assert.equal(destinations[1].label, 'Schnellstart');
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Volumes/My\ Shared\ Files/CODEX/Plexlite/dv-control-webapp && node --test test/settings-shell.test.js test/branding.test.js`
Expected: FAIL because the current settings page still renders three large header panels and the old overview wording.

**Step 3: Write minimal implementation**

```html
<section class="panel reveal settings-compact-bar span-12">
  <div class="panel-head">...</div>
</section>
```

```js
label: 'Schnellstart'
```

**Step 4: Run test to verify it passes**

Run: `cd /Volumes/My\ Shared\ Files/CODEX/Plexlite/dv-control-webapp && node --test test/settings-shell.test.js test/branding.test.js`
Expected: PASS

### Task 4: Repurpose the tools page into the Wartung hub and move maintenance actions there

**Files:**
- Modify: `Plexlite/dv-control-webapp/public/tools.html`
- Modify: `Plexlite/dv-control-webapp/public/tools.js`
- Modify: `Plexlite/dv-control-webapp/public/settings.js`
- Modify: `Plexlite/dv-control-webapp/public/styles.css`
- Modify: `Plexlite/dv-control-webapp/test/branding.test.js`

**Step 1: Write the failing tests**

```js
test('maintenance page uses Wartung wording and includes status, import/export, history, and diagnose sections', () => {
  const html = fs.readFileSync(path.join(publicDir, 'tools.html'), 'utf8');
  assert.match(html, /DVhub Wartung/);
  assert.match(html, /Systemstatus/);
  assert.match(html, /Import &amp; Export/);
  assert.match(html, /Historie/);
  assert.match(html, /Diagnose/);
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Volumes/My\ Shared\ Files/CODEX/Plexlite/dv-control-webapp && node --test test/branding.test.js`
Expected: FAIL because the current page still presents only tools-specific content and wording.

**Step 3: Write minimal implementation**

```html
<p class="page-kicker">Wartung</p>
<h1 class="page-title">DVhub Wartung</h1>
```

**Step 4: Run test to verify it passes**

Run: `cd /Volumes/My\ Shared\ Files/CODEX/Plexlite/dv-control-webapp && node --test test/branding.test.js`
Expected: PASS

### Task 5: Align the setup page with the new Einrichtung language and cross-links

**Files:**
- Modify: `Plexlite/dv-control-webapp/public/setup.html`
- Modify: `Plexlite/dv-control-webapp/public/setup.js`
- Modify: `Plexlite/dv-control-webapp/test/setup-wizard.test.js`
- Modify: `Plexlite/dv-control-webapp/test/branding.test.js`

**Step 1: Write the failing tests**

```js
test('setup completion points users back to Einrichtung wording instead of Einstellungen', () => {
  assert.match(outcome.banner, /Einrichtung/i);
  assert.match(outcome.nextSteps.join(' '), /Einrichtung/i);
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Volumes/My\ Shared\ Files/CODEX/Plexlite/dv-control-webapp && node --test test/setup-wizard.test.js`
Expected: FAIL because the current setup copy still redirects users to `Einstellungen`.

**Step 3: Write minimal implementation**

```js
bannerParts.push('Weiterleitung zur Einrichtung...');
```

**Step 4: Run test to verify it passes**

Run: `cd /Volumes/My\ Shared\ Files/CODEX/Plexlite/dv-control-webapp && node --test test/setup-wizard.test.js`
Expected: PASS

### Task 6: Tighten the settings layout and responsive behavior

**Files:**
- Modify: `Plexlite/dv-control-webapp/public/styles.css`
- Modify: `Plexlite/dv-control-webapp/public/settings.html`
- Modify: `Plexlite/dv-control-webapp/public/tools.html`
- Modify: `Plexlite/dv-control-webapp/public/setup.html`
- Modify: `Plexlite/dv-control-webapp/test/branding.test.js`

**Step 1: Write the failing test**

```js
test('settings styles expose the compact settings bar and maintenance layout classes', () => {
  const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
  assert.match(css, /\.settings-compact-bar\s*\{/);
  assert.match(css, /\.maintenance-grid\s*\{/);
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Volumes/My\ Shared\ Files/CODEX/Plexlite/dv-control-webapp && node --test test/branding.test.js`
Expected: FAIL because the current stylesheet only defines the older header-card settings layout.

**Step 3: Write minimal implementation**

```css
.settings-compact-bar { display: grid; gap: 12px; }
.maintenance-grid { display: grid; gap: 12px; }
```

**Step 4: Run test to verify it passes**

Run: `cd /Volumes/My\ Shared\ Files/CODEX/Plexlite/dv-control-webapp && node --test test/branding.test.js`
Expected: PASS

### Task 7: Run full verification

**Files:**
- Test: `Plexlite/dv-control-webapp/test/branding.test.js`
- Test: `Plexlite/dv-control-webapp/test/settings-shell.test.js`
- Test: `Plexlite/dv-control-webapp/test/setup-wizard.test.js`
- Test: `Plexlite/dv-control-webapp/test/settings-history-import.test.js`
- Test: `Plexlite/dv-control-webapp/test/config-telemetry.test.js`

**Step 1: Run the full suite**

```bash
cd /Volumes/My\ Shared\ Files/CODEX/Plexlite/dv-control-webapp && node --test
```

**Step 2: Verify expected output**

Expected: PASS for the renamed navigation, regrouped settings destinations, moved maintenance actions, and setup wording without regressions in the existing config and history-import behavior.
