# System Discovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a manufacturer-aware server-side discovery flow that finds supported systems in the local network, lets setup and settings users select a result, and copies the selected IP into the existing host field while preserving manual entry.

**Architecture:** Add a generic discovery module with a provider registry and one initial provider, `victron`. Expose a small HTTP endpoint in `server.js`, attach field-level discovery metadata in `config-model.js`, and update both `settings.js` and `setup.js` to render the same discovery picker pattern next to discovery-capable host fields.

**Tech Stack:** Node.js, pure-JS mDNS dependency, existing DVhub HTTP server, vanilla browser JS, `node:test`

---

### Task 1: Add discovery metadata to the config schema

**Files:**
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/config-model.js`
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/test/setup-wizard.test.js`

**Step 1: Write the failing test**

```js
test('transport host field declares manufacturer-aware discovery metadata', () => {
  const definition = getConfigDefinition();
  const hostField = definition.fields.find((field) => field.path === 'victron.host');

  assert.deepEqual(hostField.discovery, {
    manufacturerPath: 'manufacturer',
    actionLabel: 'Find System IP'
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd '/Volumes/My Shared Files/CODEX/DVhub/dvhub' && node --test test/setup-wizard.test.js`
Expected: FAIL because the config schema does not yet declare discovery metadata for the host field.

**Step 3: Write minimal implementation**

```js
{
  path: 'victron.host',
  label: 'Anlagenadresse',
  type: 'text',
  discovery: {
    manufacturerPath: 'manufacturer',
    actionLabel: 'Find System IP'
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd '/Volumes/My Shared Files/CODEX/DVhub/dvhub' && node --test test/setup-wizard.test.js`
Expected: PASS

### Task 2: Add backend discovery module tests before implementation

**Files:**
- Create: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/test/system-discovery.test.js`
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/package.json`

**Step 1: Write the failing test**

```js
test('discoverSystems dispatches by manufacturer and deduplicates normalized results', async () => {
  const calls = [];
  const systems = await discoverSystems({
    manufacturer: 'victron',
    timeoutMs: 1500,
    providers: {
      victron: async () => {
        calls.push('victron');
        return [
          { label: 'Venus GX', host: 'venus.local', ip: '192.168.1.20' },
          { label: 'Venus GX', host: 'venus.local', ip: '192.168.1.20' }
        ];
      }
    }
  });

  assert.deepEqual(calls, ['victron']);
  assert.equal(systems.length, 1);
  assert.equal(systems[0].ip, '192.168.1.20');
});
```

**Step 2: Run test to verify it fails**

Run: `cd '/Volumes/My Shared Files/CODEX/DVhub/dvhub' && node --test test/system-discovery.test.js`
Expected: FAIL because no discovery module or dependency exists yet.

**Step 3: Write minimal implementation**

```js
export async function discoverSystems({ manufacturer, timeoutMs = 1500, providers = DEFAULT_PROVIDERS }) {
  const provider = providers[manufacturer];
  if (!provider) throw new Error(`discovery not supported for manufacturer: ${manufacturer}`);
  return normalizeAndDedupe(await provider({ timeoutMs }));
}
```

**Step 4: Run test to verify it passes**

Run: `cd '/Volumes/My Shared Files/CODEX/DVhub/dvhub' && node --test test/system-discovery.test.js`
Expected: PASS

### Task 3: Implement the generic discovery module with a Victron provider

**Files:**
- Create: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/system-discovery.js`
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/package.json`
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/test/system-discovery.test.js`

**Step 1: Write the failing test**

```js
test('discoverSystems returns an empty list on provider timeout and rejects unknown manufacturers cleanly', async () => {
  await assert.rejects(
    () => discoverSystems({ manufacturer: 'unknown', providers: {} }),
    /not supported/i
  );

  const systems = await discoverSystems({
    manufacturer: 'victron',
    providers: {
      victron: async () => {
        throw new DiscoveryTimeoutError('timed out');
      }
    }
  });

  assert.deepEqual(systems, []);
});
```

**Step 2: Run test to verify it fails**

Run: `cd '/Volumes/My Shared Files/CODEX/DVhub/dvhub' && node --test test/system-discovery.test.js`
Expected: FAIL because timeout handling and the concrete provider contract do not yet exist.

**Step 3: Write minimal implementation**

```js
export class DiscoveryTimeoutError extends Error {}

async function discoverVictronSystems({ timeoutMs, mdnsFactory = createMdnsBrowser }) {
  const browser = mdnsFactory();
  return await browseVictronAnnouncements(browser, timeoutMs);
}

const DEFAULT_PROVIDERS = {
  victron: discoverVictronSystems
};
```

**Step 4: Run test to verify it passes**

Run: `cd '/Volumes/My Shared Files/CODEX/DVhub/dvhub' && node --test test/system-discovery.test.js`
Expected: PASS

### Task 4: Add the HTTP discovery endpoint

**Files:**
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/server.js`
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/test/system-discovery.test.js`

**Step 1: Write the failing test**

```js
test('buildSystemDiscoveryPayload returns manufacturer-scoped API responses', async () => {
  const payload = await buildSystemDiscoveryPayload({
    query: { manufacturer: 'victron' },
    discoverSystems: async () => [{ id: 'a', label: 'Venus GX', host: 'venus.local', ip: '192.168.1.20' }]
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.manufacturer, 'victron');
  assert.equal(payload.systems[0].ip, '192.168.1.20');
});
```

**Step 2: Run test to verify it fails**

Run: `cd '/Volumes/My Shared Files/CODEX/DVhub/dvhub' && node --test test/system-discovery.test.js`
Expected: FAIL because no API payload helper or route exists yet.

**Step 3: Write minimal implementation**

```js
if (url.pathname === '/api/discovery/systems' && req.method === 'GET') {
  const payload = await buildSystemDiscoveryPayload({ query: Object.fromEntries(url.searchParams) });
  return json(res, 200, payload);
}
```

**Step 4: Run test to verify it passes**

Run: `cd '/Volumes/My Shared Files/CODEX/DVhub/dvhub' && node --test test/system-discovery.test.js`
Expected: PASS

### Task 5: Add settings UI state and tests for the discovery picker

**Files:**
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/public/settings.js`
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/test/settings-shell.test.js`

**Step 1: Write the failing test**

```js
test('settings discovery helper fills the host field from a selected system', async () => {
  const state = createDiscoveryState({
    manufacturer: 'victron',
    systems: [{ id: 'a', label: 'Venus GX', host: 'venus.local', ip: '192.168.1.20' }]
  });

  const next = applyDiscoveredSystemToDraft({
    draftConfig: { manufacturer: 'victron', victron: { host: '' } },
    fieldPath: 'victron.host',
    selectedSystemId: 'a',
    discoveryState: state
  });

  assert.equal(next.victron.host, '192.168.1.20');
});
```

**Step 2: Run test to verify it fails**

Run: `cd '/Volumes/My Shared Files/CODEX/DVhub/dvhub' && node --test test/settings-shell.test.js`
Expected: FAIL because settings has no discovery state helpers or host-apply logic.

**Step 3: Write minimal implementation**

```js
function applyDiscoveredSystemToDraft({ draftConfig, fieldPath, selectedSystemId, discoveryState }) {
  const selected = discoveryState.systems.find((system) => system.id === selectedSystemId);
  const next = clone(draftConfig || {});
  setPath(next, fieldPath, selected?.ip || '');
  return next;
}
```

**Step 4: Run test to verify it passes**

Run: `cd '/Volumes/My Shared Files/CODEX/DVhub/dvhub' && node --test test/settings-shell.test.js`
Expected: PASS

### Task 6: Render the settings discovery action and wire the API request

**Files:**
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/public/settings.js`
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/test/settings-shell.test.js`

**Step 1: Write the failing test**

```js
test('settings field rendering exposes discovery UI for discovery-capable host fields', () => {
  const field = {
    path: 'victron.host',
    label: 'Anlagenadresse',
    type: 'text',
    discovery: { manufacturerPath: 'manufacturer', actionLabel: 'Find System IP' }
  };

  const model = buildFieldRenderModel(field, {
    draftConfig: { manufacturer: 'victron', victron: { host: '' } },
    effectiveConfig: {}
  });

  assert.equal(model.discovery.visible, true);
  assert.equal(model.discovery.manufacturer, 'victron');
});
```

**Step 2: Run test to verify it fails**

Run: `cd '/Volumes/My Shared Files/CODEX/DVhub/dvhub' && node --test test/settings-shell.test.js`
Expected: FAIL because settings field rendering does not yet expose discovery state.

**Step 3: Write minimal implementation**

```js
const manufacturer = getPath(currentDraftConfig, field.discovery.manufacturerPath)
  || getPath(currentEffectiveConfig, field.discovery.manufacturerPath)
  || '';
```

**Step 4: Run test to verify it passes**

Run: `cd '/Volumes/My Shared Files/CODEX/DVhub/dvhub' && node --test test/settings-shell.test.js`
Expected: PASS

### Task 7: Add setup UI state and tests for the discovery picker

**Files:**
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/public/setup.js`
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/test/setup-wizard.test.js`

**Step 1: Write the failing test**

```js
test('setup discovery helper fills the host field from the selected system without changing validation rules', () => {
  const nextState = applyDiscoveredSystemToSetupState({
    state: createSampleState({
      config: { manufacturer: 'victron', victron: { host: '' } }
    }),
    fieldPath: 'victron.host',
    selectedSystem: { id: 'a', ip: '192.168.1.20' }
  });

  assert.equal(nextState.draftConfig.victron.host, '192.168.1.20');
  assert.equal(nextState.validation.steps.transport.valid, true);
});
```

**Step 2: Run test to verify it fails**

Run: `cd '/Volumes/My Shared Files/CODEX/DVhub/dvhub' && node --test test/setup-wizard.test.js`
Expected: FAIL because setup has no discovery state helpers or apply logic.

**Step 3: Write minimal implementation**

```js
function applyDiscoveredSystemToSetupState({ state, fieldPath, selectedSystem }) {
  return updateSetupDraftValue(state, fieldPath, selectedSystem?.ip || '');
}
```

**Step 4: Run test to verify it passes**

Run: `cd '/Volumes/My Shared Files/CODEX/DVhub/dvhub' && node --test test/setup-wizard.test.js`
Expected: PASS

### Task 8: Render the setup discovery action and wire the same API request

**Files:**
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/public/setup.js`
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/test/setup-wizard.test.js`

**Step 1: Write the failing test**

```js
test('setup transport field rendering exposes discovery UI for the host field', () => {
  const state = setActiveSetupStep(createSampleState({
    config: { manufacturer: 'victron', victron: { host: '' } }
  }), 'transport');
  const field = getVisibleSetupFieldsForStep(state, 'transport')
    .find((entry) => entry.path === 'victron.host');

  const model = buildSetupFieldRenderModel(state, field);

  assert.equal(model.discovery.visible, true);
  assert.equal(model.discovery.manufacturer, 'victron');
});
```

**Step 2: Run test to verify it fails**

Run: `cd '/Volumes/My Shared Files/CODEX/DVhub/dvhub' && node --test test/setup-wizard.test.js`
Expected: FAIL because setup field rendering does not yet include discovery state.

**Step 3: Write minimal implementation**

```js
function buildSetupFieldRenderModel(state, field) {
  return {
    value: resolveWizardValue(state, field.path, ''),
    discovery: resolveFieldDiscoveryState(field, state)
  };
}
```

**Step 4: Run test to verify it passes**

Run: `cd '/Volumes/My Shared Files/CODEX/DVhub/dvhub' && node --test test/setup-wizard.test.js`
Expected: PASS

### Task 9: Verify the complete discovery flow

**Files:**
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/test/system-discovery.test.js`
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/test/settings-shell.test.js`
- Modify: `/Volumes/My Shared Files/CODEX/DVhub/dvhub/test/setup-wizard.test.js`

**Step 1: Write the failing test**

```js
test('discovery errors leave manual host entry available in both UI flows', () => {
  const settingsState = createDiscoveryState({ manufacturer: 'victron', error: 'network unavailable' });
  const setupState = createSetupDiscoveryState({ manufacturer: 'victron', error: 'network unavailable' });

  assert.equal(settingsState.disabled, false);
  assert.equal(setupState.disabled, false);
  assert.match(settingsState.message, /manuell/i);
  assert.match(setupState.message, /manuell/i);
});
```

**Step 2: Run test to verify it fails**

Run: `cd '/Volumes/My Shared Files/CODEX/DVhub/dvhub' && node --test test/system-discovery.test.js test/settings-shell.test.js test/setup-wizard.test.js`
Expected: FAIL because the final empty/error-state UI contract is not yet encoded.

**Step 3: Write minimal implementation**

```js
const message = error
  ? 'Discovery fehlgeschlagen. Du kannst die Adresse weiter manuell eintragen.'
  : 'Kein System gefunden. Du kannst die Adresse weiter manuell eintragen.';
```

**Step 4: Run test to verify it passes**

Run: `cd '/Volumes/My Shared Files/CODEX/DVhub/dvhub' && node --test test/system-discovery.test.js test/settings-shell.test.js test/setup-wizard.test.js`
Expected: PASS
