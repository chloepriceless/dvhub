# Settings + Setup Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild settings.html and setup.html with responsive multi-column grid layout, compact key-value rows, and colored group-cards matching the Energy Flow dashboard design.

**Architecture:** Replace all render functions in settings.js and setup.js to emit new `.config-*` CSS classes in a responsive grid. Settings uses 4 horizontal tabs with DOM show/hide. Setup becomes a single-page form with no wizard. Both share the same group-card and key-value-row components. A sticky save-bar appears when changes are detected.

**Tech Stack:** Vanilla JS (DOM manipulation), Custom CSS (no frameworks), existing config-model.js definition API.

**Spec:** `docs/superpowers/specs/2026-03-23-settings-setup-redesign.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `public/styles.css` | New `.config-*` CSS components + remove old settings/setup CSS | Modify |
| `public/settings.html` | 4-tab layout, save-bar, remove navTree | Modify |
| `public/settings.js` | New render functions: grid, group-cards, KV-rows, save-bar, tab logic | Modify |
| `public/setup.html` | Single-page form, save-bar, remove wizard shell | Modify |
| `public/setup.js` | New render functions: group-cards, KV-rows, setup save logic | Modify |

Note: `config-model.js`, `common.js`, `tools.js` remain unchanged. The definition structure (destinations, sections, fields) from the server drives the rendering — that API does not change.

---

### Task 1: CSS — Add new `.config-*` component classes

**Files:**
- Modify: `public/styles.css`

- [ ] **Step 1: Add new config component CSS at the end of styles.css**

Add after the existing Energy Flow section. These are the new shared components for Settings and Setup:

```css
/* ============================================================
   CONFIG COMPONENTS — Shared by Settings + Setup
   ============================================================ */

/* Responsive grid */
.config-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}
@media (min-width: 700px)  { .config-grid { grid-template-columns: 1fr 1fr; } }
@media (min-width: 1100px) { .config-grid { grid-template-columns: 1fr 1fr 1fr; } }

/* Group card with accent left-border */
.config-group {
  background: rgba(16,26,42,0.9);
  border: 1px solid rgba(123,151,178,0.18);
  border-radius: 10px;
  border-left: 3px solid rgba(123,151,178,0.18);
  box-shadow: 0 2px 8px rgba(0,0,0,0.25);
}
.config-group[data-accent="green"]  { border-left-color: var(--flow-green, #4CE36C); }
.config-group[data-accent="yellow"] { border-left-color: var(--flow-yellow, #FFD32E); }
.config-group[data-accent="blue"]   { border-left-color: var(--flow-blue, #00A8FF); }
.config-group[data-accent="cyan"]   { border-left-color: var(--flow-cyan, #22D3EE); }
.config-group[data-accent="purple"] { border-left-color: var(--flow-purple, #A78BFA); }
.config-group[data-accent="orange"] { border-left-color: var(--flow-orange, #FF9F43); }

/* Group kicker label */
.config-group-kicker {
  font-family: var(--font-title, 'Space Grotesk', sans-serif);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 10px 14px 2px;
}

/* Key-value row */
.config-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 9px 14px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  font-size: 12px;
}
.config-row:last-child { border-bottom: none; }
.config-row-label { color: rgba(232,234,240,0.5); white-space: nowrap; }
.config-row-label .config-required { color: var(--flow-green, #4CE36C); margin-left: 3px; }
.config-row-value { font-weight: 500; font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 11px; }

/* Config inputs */
.config-input {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px;
  padding: 5px 10px;
  color: var(--flow-text, #e8eaf0);
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 11px;
  text-align: right;
  min-width: 0;
}
.config-input:focus { border-color: var(--flow-green, #4CE36C); outline: none; }
.config-input.has-error { border-color: var(--flow-red, rgba(255,108,99,0.85)); }
.config-select {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px;
  padding: 5px 10px;
  color: var(--flow-text, #e8eaf0);
  font-size: 11px;
}
.config-checkbox { accent-color: var(--flow-green, #4CE36C); width: 16px; height: 16px; }

/* Sticky save bar */
.config-save-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 10px 16px;
  background: rgba(11,15,26,0.95);
  border-top: 1px solid rgba(123,151,178,0.18);
  backdrop-filter: blur(12px);
  display: flex;
  justify-content: space-between;
  align-items: center;
  z-index: 100;
  transform: translateY(100%);
  transition: transform 0.2s ease-out;
}
body.has-changes .config-save-bar { transform: translateY(0); }
.config-save-bar-text { font-size: 11px; color: rgba(232,234,240,0.5); }
.config-save-bar-actions { display: flex; gap: 8px; }

/* Setup centered container */
.setup-container { max-width: 860px; margin: 0 auto; }

/* Config status banner */
.config-banner { padding: 8px 14px; border-radius: 8px; font-size: 11px; margin-bottom: 12px; }
.config-banner.ok { background: rgba(76,227,108,0.08); border: 1px solid rgba(76,227,108,0.2); color: #4CE36C; }
.config-banner.warn { background: rgba(255,211,46,0.08); border: 1px solid rgba(255,211,46,0.2); color: #FFD32E; }
.config-banner.error { background: rgba(255,108,99,0.08); border: 1px solid rgba(255,108,99,0.2); color: rgba(255,108,99,0.85); }
```

- [ ] **Step 2: Add accent color CSS variables**

These variables do NOT yet exist in `:root`. Add them to the `:root` block at the top of styles.css:

```css
--flow-green: #4CE36C;
--flow-yellow: #FFD32E;
--flow-blue: #00A8FF;
--flow-cyan: #22D3EE;
--flow-purple: #A78BFA;
--flow-orange: #FF9F43;
--flow-red: rgba(255,108,99,0.85);
```

- [ ] **Step 3: Verify CSS loads without errors**

Deploy to test system and confirm page loads: `scp styles.css root@192.168.20.53:/opt/dvhub/dvhub/public/styles.css`

- [ ] **Step 4: Commit**

```bash
git add public/styles.css
git commit -m "style: add config-grid, config-group, config-row component CSS"
```

---

### Task 2: Settings HTML — Rebuild page structure

**Files:**
- Modify: `public/settings.html`

- [ ] **Step 1: Replace the settings.html content between `<main>` tags**

Keep: topbar (lines 19-33), script tags at bottom.
Replace: everything inside `<main class="page-content">` with:

```html
<main class="page-content">
  <!-- Page header -->
  <div style="display:flex;justify-content:space-between;align-items:baseline;padding:16px 16px 0;">
    <h1 style="font-family:var(--font-title);font-size:18px;font-weight:600;">Einstellungen</h1>
    <small id="configMeta" style="font-size:11px;color:rgba(232,234,240,0.25);font-family:var(--font-mono);">-</small>
  </div>

  <!-- Tabs -->
  <div class="settings-tabs">
    <button class="settings-tab is-active" data-tab="connection">Anlage</button>
    <button class="settings-tab" data-tab="control">Steuerung</button>
    <button class="settings-tab" data-tab="services">Preise</button>
    <button class="settings-tab" data-tab="system">System</button>
  </div>

  <!-- Tab panels -->
  <div style="padding:12px 16px 80px;">
    <div id="settingsBanner" class="config-banner warn">Konfiguration wird geladen...</div>

    <div id="tab-connection" class="settings-tab-panel">
      <div id="connectionBanner" class="config-banner" style="display:none;"></div>
      <div id="connectionGrid" class="config-grid"></div>
    </div>
    <div id="tab-control" class="settings-tab-panel" hidden>
      <div id="controlGrid" class="config-grid"></div>
    </div>
    <div id="tab-services" class="settings-tab-panel" hidden>
      <div id="servicesGrid" class="config-grid"></div>
    </div>
    <div id="tab-system" class="settings-tab-panel" hidden>
      <!-- Keep existing system tab content (health, update, import/export, etc.) -->
    </div>
  </div>

  <!-- Sticky save bar -->
  <div class="config-save-bar">
    <span class="config-save-bar-text" id="saveBarText">-</span>
    <div class="config-save-bar-actions">
      <button id="discardBtn" class="btn btn-ghost">Verwerfen</button>
      <button id="saveConfigBtn" class="btn btn-primary">Speichern</button>
    </div>
  </div>
</main>
```

- [ ] **Step 2: Move System tab HTML content into `#tab-system`**

Move the existing `systemTabContent` div contents (health, update, import/export, history, API docs, diagnose, modbus-scan, schedule, DV-log cards) into `#tab-system`. Remove the old `systemTabContent` wrapper and its `style="display:none"`.

- [ ] **Step 3: Replace the tab-switching script**

Replace the entire inline `<script>` block with:

```html
<script>
// Tab switching
document.querySelectorAll('.settings-tab').forEach(function(tab) {
  tab.addEventListener('click', function() {
    var target = tab.dataset.tab;
    document.querySelectorAll('.settings-tab').forEach(function(t) { t.classList.remove('is-active'); });
    tab.classList.add('is-active');
    document.querySelectorAll('.settings-tab-panel').forEach(function(p) { p.hidden = true; });
    var panel = document.getElementById('tab-' + target);
    if (panel) panel.hidden = false;
    history.replaceState(null, '', '#' + target);
    if (window.DVhubSettings) window.DVhubSettings.onTabSwitch(target);
  });
});
// Restore tab from URL hash
var hash = location.hash.replace('#', '');
if (hash) {
  var tab = document.querySelector('.settings-tab[data-tab="' + hash + '"]');
  if (tab) tab.click();
}
</script>
```

- [ ] **Step 4: Remove old elements**

Remove: `#settingsNavTree`, `#settingsWorkspace`, `#settingsSections`, `#reloadConfigBtn`, the old `page-header-card` div. These are replaced by the new structure.

- [ ] **Step 5: Commit**

```bash
git add public/settings.html
git commit -m "feat(settings): rebuild HTML with 4-tab layout and save bar"
```

---

### Task 3: Settings JS — Rewrite render functions

**Files:**
- Modify: `public/settings.js`

This is the largest task. The key change: replace `renderSectionWorkspace()`, `renderSidebarNavigation()`, `renderField()`, and `buildDisclosureSummaryMarkup()` with new functions that emit `config-grid`, `config-group`, and `config-row` HTML.

- [ ] **Step 1: Add shared DOM builder helpers at the top of settings.js (after variable declarations)**

```javascript
function createConfigGroup(label, accent) {
  const group = document.createElement('div');
  group.className = 'config-group';
  if (accent) group.dataset.accent = accent;
  const kicker = document.createElement('div');
  kicker.className = 'config-group-kicker';
  kicker.style.color = `var(--flow-${accent || 'green'})`;
  kicker.textContent = label;
  group.appendChild(kicker);
  return group;
}

function createConfigRow(label, inputEl, opts) {
  const row = document.createElement('div');
  row.className = 'config-row';
  const labelSpan = document.createElement('span');
  labelSpan.className = 'config-row-label';
  labelSpan.textContent = label;
  if (opts?.required) {
    const req = document.createElement('span');
    req.className = 'config-required';
    req.textContent = '*';
    labelSpan.appendChild(req);
  }
  row.appendChild(labelSpan);
  if (typeof inputEl === 'string') {
    const val = document.createElement('strong');
    val.className = 'config-row-value';
    val.textContent = inputEl;
    row.appendChild(val);
  } else {
    row.appendChild(inputEl);
  }
  return row;
}

function createConfigInput(field, value) {
  let input;
  if (field.type === 'boolean') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'config-checkbox';
    input.checked = Boolean(value);
  } else if (field.type === 'select') {
    input = document.createElement('select');
    input.className = 'config-select';
    for (const opt of field.options || []) {
      const option = document.createElement('option');
      option.value = String(opt.value);
      option.textContent = opt.label;
      input.appendChild(option);
    }
    input.value = String(value);
  } else if (field.type === 'dynamicSelect') {
    input = document.createElement('select');
    input.className = 'config-select';
    const placeholder = document.createElement('option');
    placeholder.value = String(value || '');
    placeholder.textContent = value ? String(value) : 'Laden...';
    input.appendChild(placeholder);
    if (field.dynamicOptionsUrl) {
      apiFetch(field.dynamicOptionsUrl).then(data => {
        input.innerHTML = '';
        for (const z of (data?.zones || [])) {
          const opt = document.createElement('option');
          opt.value = z.zone;
          opt.textContent = z.zone;
          input.appendChild(opt);
        }
        input.value = String(value || 'DE-LU');
      }).catch(() => { placeholder.textContent = value || 'Fehler'; });
    }
  } else {
    input = document.createElement('input');
    input.type = field.type === 'number' ? 'number' : (field.type === 'time' ? 'time' : 'text');
    input.className = 'config-input';
    if (field.min !== undefined) input.min = field.min;
    if (field.max !== undefined) input.max = field.max;
    if (field.step !== undefined) input.step = field.step;
    input.value = value === null || value === undefined ? '' : String(value);
    input.style.width = field.type === 'number' ? '70px' : '140px';
  }
  input.id = fieldId(field.path);
  input.dataset.path = field.path;
  input.dataset.type = field.type;
  return input;
}
```

- [ ] **Step 2: Replace `renderSectionWorkspace()` with `renderDestinationGrid()`**

```javascript
function renderDestinationGrid(destinationId) {
  const gridId = destinationId + 'Grid';
  const mount = document.getElementById(gridId);
  if (!mount) return;
  mount.innerHTML = '';

  const destination = buildDestinationWorkspace(definition, destinationId);
  if (!destination || !destination.sections.length) return;

  for (const section of destination.sections) {
    // Use pre-resolved fields from workspace, with group expansion
    const allFields = [];
    for (const group of section.groups || []) {
      for (const field of group.fields || []) {
        if (field.type !== 'array' && isFieldVisible(field)) allFields.push(field);
      }
    }
    const fields = allFields;
    if (!fields.length) continue;

    const group = createConfigGroup(section.label, getGroupAccent(section));

    for (const field of fields) {
      const model = buildFieldRenderModel(field);
      const input = createConfigInput(field, model.value);
      group.appendChild(createConfigRow(field.label, input));
    }

    mount.appendChild(group);

    // Special editors for pricing section
    if (section.id === 'pricing') {
      mount.appendChild(renderEpexPriceSourceInfo());
      mount.appendChild(renderPvPlantsEditor());
      mount.appendChild(renderPricingPeriodsEditor());
    }
  }

  if (shouldRenderHistoryImportPanel(destinationId)) {
    mount.appendChild(renderHistoryImportPanel(destinationId));
  }
}
```

- [ ] **Step 3: Add `getGroupAccent()` helper and accent mapping**

```javascript
const GROUP_ACCENTS = {
  connection: 'green', transport: 'green', victron: 'green',
  modbus: 'yellow', dvProxy: 'yellow', dv: 'yellow', control: 'yellow',
  schedule: 'green', automation: 'yellow', dvControl: 'blue',
  location: 'blue', standort: 'blue',
  telemetry: 'cyan', vrm: 'cyan',
  webserver: 'purple', http: 'purple', api: 'purple',
  mqtt: 'orange',
  epex: 'green', pricing: 'yellow', pvPlants: 'blue'
};

function getGroupAccent(section) {
  return GROUP_ACCENTS[section.id] || GROUP_ACCENTS[section.destination] || 'green';
}
```

- [ ] **Step 4: Replace `renderSettingsShell()` to render all tabs at once**

```javascript
function renderSettingsShell() {
  settingsShellState = createSettingsShellState(definition, settingsShellState.activeSectionId);
  // Render all destination grids (skip 'system' — static HTML, no JS grid)
  // Destination IDs from server definition: 'quickstart', 'connection', 'control', 'services', 'advanced'
  // We map quickstart+connection+advanced → connectionGrid, control → controlGrid, services → servicesGrid
  const DEST_TO_GRID = { connection: 'connection', control: 'control', services: 'services' };
  for (const dest of settingsShellState.destinations) {
    const gridKey = DEST_TO_GRID[dest.id];
    if (!gridKey) continue; // skip quickstart, advanced (merged into connection), system
    renderDestinationGrid(dest.id);
  }
}
```

- [ ] **Step 5: Replace `activateSettingsDestination()` — no longer needed for tab switching**

The tab switching is now pure DOM show/hide in settings.html. But we still need the function for syncing draft state:

```javascript
function activateSettingsDestination(sectionId) {
  syncRenderedFieldsToDraft();
}
```

- [ ] **Step 6: Add dirty-state detection and save-bar logic**

```javascript
function updateSaveBar() {
  const changed = JSON.stringify(currentDraftConfig) !== JSON.stringify(currentRawConfig);
  document.body.classList.toggle('has-changes', changed);
  const text = document.getElementById('saveBarText');
  if (text) {
    const count = countChangedFields();
    text.textContent = changed ? `${count} Feld${count === 1 ? '' : 'er'} geaendert` : '';
  }
}

function countChangedFields() {
  let count = 0;
  for (const field of definition?.fields || []) {
    const input = document.getElementById(fieldId(field.path));
    if (!input) continue;
    const draft = parseFieldInput(field);
    const saved = getPath(currentRawConfig, field.path);
    if (JSON.stringify(draft) !== JSON.stringify(saved)) count++;
  }
  return count;
}
```

- [ ] **Step 7: Update `initSettingsPage()` to wire up new elements**

Remove the old `[data-settings-target]` click handler from `initSettingsPage()` (line ~1760 in the original). Tab switching is now handled purely by the inline script in settings.html.

Add event listeners for:
- `#discardBtn` click: reset draft to saved, re-render, update save bar
- All tab panels: delegated `change` event on each `*Grid` div to call `syncRenderedFieldsToDraft()` then `updateSaveBar()`
- Guard: only call `updateSaveBar()` after `definition` is loaded (after `loadConfig()` resolves)

Update the export:
```javascript
window.DVhubSettings = {
  activate: activateSettingsDestination,
  onTabSwitch: function(tabId) { syncRenderedFieldsToDraft(); }
};
```

- [ ] **Step 8: Remove dead functions**

Remove: `renderSidebarNavigation()`, `renderSectionWorkspace()`, `buildDisclosureSummaryMarkup()`, `renderField()` (the old one), `buildSectionMeta()`, `getActiveSettingsDestination()`, `renderActiveSettingsDestination()`.

Keep: `renderHistoryImportPanel()`, `renderEpexPriceSourceInfo()`, `renderPricingPeriodsEditor()`, `renderPvPlantsEditor()`, `renderHealth()`, `loadHealth()`, all API/save/load functions, `syncRenderedFieldsToDraft()`, `parseFieldInput()`, `collectConfigFromForm()`, discovery functions.

Note: The existing `loadHealth()` populates `#healthBanner` etc. in the System tab — this still works because the System tab HTML is kept as-is. For the `#connectionBanner` on the Anlage tab, add a simple status fetch in `initSettingsPage()` that loads `/api/status` and sets the banner text/class based on connection state.

- [ ] **Step 9: Test on test system**

```bash
scp public/settings.js root@192.168.20.53:/opt/dvhub/dvhub/public/settings.js
scp public/settings.html root@192.168.20.53:/opt/dvhub/dvhub/public/settings.html
ssh root@192.168.20.53 "systemctl restart dvhub"
```

Open http://192.168.20.53:8080/settings.html — verify:
- 4 tabs work, URL hash updates
- Group-cards render with colored accents
- Fields show current config values
- Save bar appears on field change
- Save + Discard work

- [ ] **Step 10: Commit**

```bash
git add public/settings.js public/settings.html
git commit -m "feat(settings): rewrite render to config-grid with group-cards and KV-rows"
```

---

### Task 4: Setup HTML — Rebuild as single-page form

**Files:**
- Modify: `public/setup.html`

- [ ] **Step 1: Replace setup.html body content**

Keep: topbar, `<script src="/common.js">`, `<script src="/setup.js">`.
Replace everything inside `<main>` with:

```html
<main class="page-content">
  <div class="setup-container" style="padding:16px 16px 80px;">
    <div style="text-align:center;margin-bottom:16px;">
      <h1 style="font-family:var(--font-title);font-size:20px;font-weight:600;">DVhub einrichten</h1>
      <p style="font-size:12px;color:rgba(232,234,240,0.5);">Pflichtfelder ausfuellen, speichern, fertig.</p>
    </div>

    <div id="setupBanner" class="config-banner warn">Setup wird geladen...</div>

    <div id="setupGrid" class="config-grid"></div>

    <div id="setupImportRow" style="text-align:center;margin-top:16px;">
      <p style="font-size:11px;color:rgba(232,234,240,0.25);">Oder <a id="setupImportLink" href="#" style="color:#4CE36C;text-decoration:none;">vorhandene Config importieren</a></p>
      <input id="setupImportFile" type="file" accept="application/json,.json" hidden />
    </div>
  </div>

  <div class="config-save-bar" style="justify-content:center;gap:12px;">
    <span class="config-save-bar-text" id="setupSaveBarText">-</span>
    <button id="setupSaveBtn" class="btn btn-primary" style="padding:10px 28px;font-size:13px;font-weight:600;">Konfiguration speichern</button>
  </div>
</main>
```

- [ ] **Step 2: Commit**

```bash
git add public/setup.html
git commit -m "feat(setup): rebuild HTML as single-page form"
```

---

### Task 5: Setup JS — Rewrite render functions

**Files:**
- Modify: `public/setup.js`

- [ ] **Step 1: Replace `renderSetupSteps()`, `renderSetupWorkspace()`, `renderSetupNav()`, `renderSetupErrors()`, `renderSetupOutcome()` with a single `renderSetupForm()`**

```javascript
function renderSetupForm() {
  const grid = document.getElementById('setupGrid');
  if (!grid) return;
  grid.innerHTML = '';

  const steps = getSetupStepDefinitions();
  for (const step of steps) {
    const fields = getVisibleSetupFieldsForStep(setupWizardState, step.id);
    if (!fields.length) continue;

    const accent = SETUP_GROUP_ACCENTS[step.id] || 'green';
    const group = createConfigGroup(step.title, accent);

    for (const field of fields) {
      const model = buildSetupFieldRenderModel(setupWizardState, field);
      const input = createConfigInput(field, model.value);
      const required = field.setup?.required || false;
      group.appendChild(createConfigRow(field.label, input, { required }));

      // Discovery button
      if (model.discovery.visible) {
        const actions = document.createElement('div');
        actions.style.cssText = 'padding:4px 14px 8px;';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-ghost btn-small';
        btn.dataset.discoveryRun = field.path;
        btn.disabled = model.discovery.loading || !model.discovery.manufacturer;
        btn.textContent = model.discovery.loading ? 'Suche...' : model.discovery.actionLabel;
        actions.appendChild(btn);
        group.appendChild(actions);
      }
    }

    grid.appendChild(group);
  }

  updateSetupSaveBar();
}

const SETUP_GROUP_ACCENTS = {
  basics: 'cyan',
  transport: 'green',
  dv: 'yellow',
  services: 'blue'
};
```

- [ ] **Step 2: Add `updateSetupSaveBar()`**

```javascript
function updateSetupSaveBar() {
  const text = document.getElementById('setupSaveBarText');
  if (!text) return;
  const required = getSetupFieldDefinitions().filter(f => f.setup?.required);
  const empty = required.filter(f => {
    const input = document.getElementById(getFieldInputId(f.path));
    if (!input) return true;
    return f.type === 'boolean' ? false : !String(input.value).trim();
  });
  text.textContent = empty.length ? `${empty.length} Pflichtfeld${empty.length === 1 ? '' : 'er'} offen` : 'Bereit';
  // Show save bar always for setup
  document.body.classList.add('has-changes');
}
```

- [ ] **Step 3: Replace `renderSetupWizard()` to call `renderSetupForm()`**

```javascript
function renderSetupWizard() {
  renderPrimarySetupAction();
  renderSetupForm();
  updateMeta();
}
```

- [ ] **Step 4: Remove dead functions**

Remove: `renderSetupSteps()`, old `renderSetupWorkspace()`, `renderSetupNav()`, `renderSetupErrors()`, `renderSetupOutcome()`, `renderSetupInheritedInfo()`, `renderField()` (setup version), `describeSetupStep()`, `buildSetupReviewSnapshot()`, `shouldPrimarySetupActionSave()`, `getPrimarySetupActionLabel()`, `getSetupNavActionLabel()`.

Keep: All state management functions, `syncActiveWorkspaceFieldsToDraft()`, `createSetupWizardState()`, `setSetupWizardState()`, validation functions, save/import functions, discovery functions.

- [ ] **Step 5: Import shared helpers from settings.js**

The `createConfigGroup()`, `createConfigRow()`, `createConfigInput()` functions are defined in settings.js. For setup.js to use them, export them:

In settings.js add to the export:
```javascript
window.DVhubConfig = { createConfigGroup, createConfigRow, createConfigInput };
```

In setup.js, reference them:
```javascript
const { createConfigGroup, createConfigRow, createConfigInput } = window.DVhubConfig || {};
```

Since setup.html only loads `common.js` + `setup.js` (not settings.js), **duplicate the 3 helper functions** (`createConfigGroup`, `createConfigRow`, `createConfigInput`) in setup.js. This avoids cross-file dependencies. Remove the `window.DVhubConfig` export mention — we go with duplication.

- [ ] **Step 6: Test on test system**

```bash
scp public/setup.js root@192.168.20.53:/opt/dvhub/dvhub/public/setup.js
scp public/setup.html root@192.168.20.53:/opt/dvhub/dvhub/public/setup.html
ssh root@192.168.20.53 "systemctl restart dvhub"
```

Open http://192.168.20.53:8080/setup.html — verify:
- All setup fields render in group-cards
- Pflichtfeld counter works
- Save button works
- Config import works

- [ ] **Step 7: Commit**

```bash
git add public/setup.js public/setup.html
git commit -m "feat(setup): rewrite as single-page form with config-group cards"
```

---

### Task 6: CSS Cleanup — Remove old settings/setup styles

**Files:**
- Modify: `public/styles.css`

- [ ] **Step 1: Remove old settings-specific CSS**

Remove all rules for: `.settings-panel`, `.settings-panel-head`, `.settings-panel-meta`, `.settings-subsection`, `.settings-subsection-head`, `.settings-group`, `.settings-group-list`, `.settings-group-accent`, `.settings-group-copy`, `.settings-group-title`, `.settings-group-description`, `.settings-group-hint`, `.settings-group-chevron`, `.settings-workspace-summary`, `.app-nav-subitem`.

- [ ] **Step 2: Remove old setup-specific CSS**

Remove all rules for: `.wizard-steps`, `.setup-step-*`, `.setup-pill-*`, `.setup-stepper`, `.setup-progress-*`, `.setup-callout-*`, `.setup-review-*`, `.setup-save-*`, `.setup-field`, `.setup-nav-*`, `.setup-shell .wizard-*`, `.setup-shell .setup-step-*`.

- [ ] **Step 3: Remove old `.settings-sidebar-*` and `.settings-workspace-*` CSS**

These were for the old sidebar layout. Remove: `.settings-sidebar`, `.settings-sidebar-sticky`, `.settings-sidebar-head`, `.settings-sidebar-nav`, `.settings-sidebar-item`, `.settings-sidebar-label`, `.settings-sidebar-copy`, `.settings-sidebar-status*`.

- [ ] **Step 4: Deploy and test that no visual regressions occurred**

```bash
scp public/styles.css root@192.168.20.53:/opt/dvhub/dvhub/public/styles.css
ssh root@192.168.20.53 "systemctl restart dvhub"
```

Check all pages: Dashboard, History, Explorer, Settings, Setup.

- [ ] **Step 5: Commit**

```bash
git add public/styles.css
git commit -m "style: remove legacy settings/setup CSS classes"
```

---

### Task 7: Deploy and verify

- [ ] **Step 1: Deploy all changed files to test system**

```bash
scp public/styles.css public/settings.html public/settings.js public/setup.html public/setup.js root@192.168.20.53:/opt/dvhub/dvhub/public/
ssh root@192.168.20.53 "systemctl restart dvhub"
```

- [ ] **Step 2: Full verification checklist**

- [ ] Settings: 4 tabs switch correctly, URL hash works
- [ ] Settings: Group-cards render with correct accent colors
- [ ] Settings: Fields show current config values from server
- [ ] Settings: Save bar appears on change, disappears after save/discard
- [ ] Settings: Save works (POST to /api/config)
- [ ] Settings: Discard reverts all changes
- [ ] Settings: System tab (health, update, etc.) still works
- [ ] Settings: Responsive: 1 col on mobile, 2 on tablet, 3 on desktop
- [ ] Setup: All fields render in group-cards
- [ ] Setup: Save works (POST to /api/config)
- [ ] Setup: Config import works
- [ ] Setup: Pflichtfeld validation works
- [ ] Dashboard, History, Explorer: No visual regressions

- [ ] **Step 3: Final commit with any fixes**

```bash
git add -A
git commit -m "fix: post-deploy adjustments for settings/setup redesign"
```
