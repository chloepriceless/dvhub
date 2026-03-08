# Architecture Research

**Domain:** Brownfield local-first Node.js webapp with settings-heavy HTML/JS frontend
**Researched:** 2026-03-08
**Confidence:** HIGH

## Standard Architecture

### System Overview

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Browser UI                                                                  │
├──────────────────────────────────────────────────────────────────────────────┤
│  Settings Shell      Setup Wizard       Dashboard / Tools                   │
│  ┌──────────────┐    ┌──────────────┐   ┌───────────────────────────────┐   │
│  │ Sidebar Nav  │    │ Step Router  │   │ Existing page controllers     │   │
│  │ Section View │    │ Step Views   │   │ stay page-oriented            │   │
│  │ Disclosure   │    │ Validation   │   │                               │   │
│  └──────┬───────┘    └──────┬───────┘   └───────────────┬───────────────┘   │
│         │                   │                           │                   │
├─────────┴───────────────────┴───────────────────────────┴───────────────────┤
│ Frontend Application Layer                                                  │
├──────────────────────────────────────────────────────────────────────────────┤
│  api-client  config-store  history-state  form-schema-adapter  ui renderers │
│  EventTarget-based pub/sub coordinates page state without a SPA runtime     │
├──────────────────────────────────────────────────────────────────────────────┤
│ Existing Node Monolith                                                      │
├──────────────────────────────────────────────────────────────────────────────┤
│  server.js routes and runtime state                                         │
│  config-model.js defaults + normalization + UI schema                       │
│  transport-modbus.js / transport-mqtt.js                                    │
├──────────────────────────────────────────────────────────────────────────────┤
│ External Boundaries                                                         │
│  Victron Modbus/MQTT  Direct-marketer Modbus  Energy Charts  InfluxDB       │
└──────────────────────────────────────────────────────────────────────────────┘
```

PlexLite already has the right macro-shape for an incremental refactor: a static multi-page frontend, a stable `/api/config` contract, and a backend schema authority in `dv-control-webapp/config-model.js`. The architectural opportunity is not to replace that shape, but to insert clearer frontend boundaries inside it so sidebar navigation, progressive disclosure, and onboarding reuse one shared config definition.

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| `config-model` | Canonical config defaults, normalization, section metadata, restart sensitivity | Keep as backend source of truth; extend field metadata instead of duplicating schema in the browser |
| `config-api` | Load/save/import config and expose health/restart metadata | Thin client around existing `/api/config`, `/api/config/import`, `/api/admin/health` |
| `settings-store` | Hold the working config draft, dirty state, active section, validation errors | Plain JS module with `EventTarget` notifications |
| `settings-shell` | Compose sidebar, top summary, section viewport, save/reload actions | Page entry module imported from `settings.js` |
| `section-renderers` | Render section panels from schema and current draft | One renderer per section family or field type, not one giant DOM function |
| `disclosure-controller` | Hide advanced/expert/danger fields by default and preserve open state | Native `<details>` where possible; APG accordion behavior only when needed |
| `setup-wizard` | Present a reduced first-run flow over the same config draft and validation rules | Step-based controller that writes into the same store and submits through the same API |
| `history-state` | Sync active sidebar section and wizard step to URL/history | `history.pushState` / `replaceState` plus hash or query param parsing |

## Recommended Project Structure

```text
dv-control-webapp/
├── server.js                    # Bootstrap and route wiring; shrink over time
├── config/
│   ├── model.js                 # Move config-model.js here first
│   ├── definition.js            # Section/field metadata
│   └── persistence.js           # load/save/normalize wrappers
├── routes/
│   ├── config-routes.js         # /api/config and import/export
│   └── admin-routes.js          # health and restart endpoints
├── services/
│   ├── schedule-service.js      # Existing schedule logic when later extracted
│   └── control-service.js       # Existing write/control logic when later extracted
├── transport/
│   ├── modbus.js                # transport-modbus.js
│   └── mqtt.js                  # transport-mqtt.js
└── public/
    ├── common/
    │   ├── api-client.js        # token-aware fetch wrapper
    │   ├── store.js             # EventTarget-backed shared state helper
    │   ├── history-state.js     # URL and navigation state sync
    │   └── validation.js        # shared field/step validation helpers
    ├── settings/
    │   ├── index.js             # page bootstrap
    │   ├── shell.js             # overall settings composition
    │   ├── sidebar.js           # nav and deep-link behavior
    │   ├── renderers/           # section and field renderers
    │   └── disclosures.js       # advanced/expert reveal logic
    ├── setup/
    │   ├── index.js             # page bootstrap
    │   ├── wizard.js            # step orchestration
    │   ├── steps/               # step-specific rendering
    │   └── summary.js           # final review/submit step
    ├── dashboard/
    │   └── index.js             # current app.js can migrate later
    ├── tools/
    │   └── index.js             # current tools.js can migrate later
    ├── styles/
    │   ├── tokens.css           # spacing, color, typography variables
    │   ├── layout.css           # shell, sidebar, panels
    │   └── components.css       # buttons, cards, disclosures, steps
    ├── settings.js              # compatibility entry that imports ./settings/index.js
    ├── setup.js                 # compatibility entry that imports ./setup/index.js
    └── common.js                # compatibility entry that imports ./common/api-client.js
```

### Structure Rationale

- **`config/`:** PlexLite already couples normalization and form metadata in one place. Split that file by responsibility only after the UI consumes it through a stable adapter, not before.
- **`routes/`:** The UI refactor should not depend on broad backend changes, but separating config/admin routes lowers future risk and makes payload contracts easier to reason about.
- **`public/common/`:** The current browser code shares almost no structure beyond `common.js`. Centralizing API, store, history, and validation helpers gives reuse without introducing a bundler.
- **`public/settings/` and `public/setup/`:** These are the highest-value refactor targets because they directly map to the project goals in `PROJECT.md`.
- **Compatibility entry files:** Preserve `settings.html` and `setup.html` script tags and migrate behind them. This reduces rollout risk and avoids a page rewrite.

## Architectural Patterns

### Pattern 1: Schema-Driven Shell With Sidebar-Navigation State

**What:** Keep one settings page, but turn it into a shell with a persistent sidebar, an active-section viewport, and deep links keyed off existing `definition.sections`. PlexLite already receives `sections` and `fields` from `getConfigDefinition()`, so the sidebar can be derived instead of hand-maintained.
**When to use:** First structural pass on `settings.html` and `settings.js`.
**Trade-offs:** Lowest rewrite risk and keeps the current API contract, but still relies on careful DOM code and disciplined module boundaries. It is not a full client router.

**Why it fits this repo:** `config-model.js` already defines section boundaries (`system`, `victron`, `meter`, `points`, `controlWrite`, `dvControl`, `schedule`, `scan`, `influx`, `epex`). That makes section navigation a metadata problem, not a framework problem.

**Example:**
```js
// public/settings/index.js
import { createConfigStore } from '../common/store.js';
import { createHistoryState } from '../common/history-state.js';
import { fetchConfig } from '../common/api-client.js';
import { mountSettingsShell } from './shell.js';

const store = createConfigStore();
const history = createHistoryState({ key: 'section', fallback: 'system' });

const payload = await fetchConfig();
store.load(payload);
store.setActiveSection(history.read());

history.onChange((sectionId) => store.setActiveSection(sectionId));
mountSettingsShell(document.getElementById('settingsSections'), store, history);
```

### Pattern 2: Metadata-Based Progressive Disclosure

**What:** Add metadata such as `audience: 'basic' | 'advanced' | 'expert'`, `danger: true`, or `collapsedByDefault: true` to field/group definitions, then let renderers decide whether to show the field inline, inside `<details>`, or inside a dedicated expert subpanel.
**When to use:** After the shell exists and users can jump between sections without scrolling the full document.
**Trade-offs:** This keeps novice views compact and preserves expert access, but it does require touching schema metadata in `config-model.js`. The reward is that setup, settings, and future docs can reuse the same classification.

**Why it fits this repo:** PlexLite’s settings are already schema-rendered. Progressive disclosure is safest when the hiding rule lives next to the field definition, not in ad hoc DOM selectors spread across `settings.js`.

**Example:**
```js
function renderGroup(group, fields, draft) {
  const basic = fields.filter((field) => field.audience !== 'expert');
  const expert = fields.filter((field) => field.audience === 'expert');

  const panel = document.createElement('section');
  panel.append(renderFieldGrid(basic, draft));

  if (expert.length) {
    const disclosure = document.createElement('details');
    disclosure.name = `${group.id}-advanced`;
    disclosure.innerHTML = '<summary>Expertenoptionen</summary>';
    disclosure.append(renderFieldGrid(expert, draft));
    panel.append(disclosure);
  }
  return panel;
}
```

### Pattern 3: Shared Draft Store For Settings And Wizard

**What:** Treat setup and settings as two views over the same draft config lifecycle: load config, edit a draft, validate, save, then surface restart-sensitive changes. The wizard should be a filtered projection of the same schema, not a separate config model.
**When to use:** After settings shell and disclosure metadata are stable enough to define which fields are first-run essentials.
**Trade-offs:** Slightly more upfront coordination, but far less long-term drift. The current `setup.js` hardcodes fields and `settings.js` renders from schema; that split will diverge if left alone.

**Why it fits this repo:** `setup.js` is only 183 lines today and already posts to `/api/config`. It is small enough to realign onto shared modules before it grows into a second settings system.

**Example:**
```js
const STEP_FIELDS = {
  basics: ['httpPort', 'apiToken'],
  victron: ['victron.transport', 'victron.host', 'victron.port', 'victron.unitId'],
  meter: ['modbusListenHost', 'modbusListenPort', 'meter.fc', 'meter.address'],
  extras: ['schedule.timezone', 'epex.enabled', 'influx.enabled']
};

function nextStep(store, currentStep) {
  const fields = STEP_FIELDS[currentStep];
  const result = store.validate(fields);
  if (!result.ok) {
    store.showErrors(result.errors);
    return;
  }
  store.advanceStep();
}
```

## Data Flow

### Request Flow

```text
[User clicks sidebar item]
    ↓
[sidebar.js]
    ↓
[settings-store.setActiveSection()]
    ↓
[history-state.push(sectionId)]
    ↓
[shell.js re-renders active panel]
    ↓
[section renderer reads schema + draft config]
    ↓
[DOM updates without reloading the page]
```

Save flow should remain intentionally boring:

```text
[User edits field]
    ↓
[renderer normalizes UI input]
    ↓
[settings-store updates draft + dirty state]
    ↓
[Save]
    ↓
[api-client POST /api/config]
    ↓
[config-model normalizeConfigInput()]
    ↓
[saveConfigFile()]
    ↓
[effectiveConfig + restartRequired returned to UI]
```

### State Management

```text
[config payload from /api/config]
    ↓
[settings-store]
    ├── rawConfig
    ├── effectiveConfig
    ├── activeSection
    ├── wizardStep
    ├── dirtyFields
    └── validationErrors
          ↓
[renderers subscribe via EventTarget]
          ↓
[sidebar, section panels, banner, step indicator update]
```

`EventTarget` is enough here because PlexLite is a local appliance UI, not a large client application. A tiny store plus explicit actions is more appropriate than introducing Redux, React, or a custom router.

### Key Data Flows

1. **Settings navigation:** `definition.sections` drives the sidebar; `history-state` keeps a bookmarkable active section; renderers only mount the visible section or a small working set.
2. **Progressive disclosure:** field metadata decides whether a control is visible, collapsed, or expert-only; the underlying config draft remains complete.
3. **Wizard onboarding:** step definitions choose a subset of the same field paths; successful step validation advances the flow; final submit still persists through `/api/config`.
4. **Restart messaging:** the backend continues to compute restart sensitivity; the frontend only displays it in section summaries, save banners, and final wizard review.

## Phase Order Implications

The order matters more than the individual techniques.

1. **Phase 1: Frontend seam extraction without UX change.**
   Move `common.js`, `settings.js`, and `setup.js` behind importable modules while keeping existing HTML entrypoints and payloads intact. This creates safe seams first.
2. **Phase 2: Settings shell and sidebar.**
   Build section navigation from existing schema metadata and reduce full-page scrolling before introducing new hiding behavior. Users need orientation before disclosure rules change.
3. **Phase 3: Progressive disclosure metadata.**
   Add audience/danger/collapsed metadata to `config-model.js`, then update settings renderers to hide advanced fields by default. Doing this before the shell would make the long page harder to reason about.
4. **Phase 4: Wizard rebuild on shared store.**
   Once the schema has stable basic/advanced classification, rebuild `setup.js` as a true multi-step wizard over the shared draft store. Otherwise the wizard would hardcode the wrong field subsets.
5. **Phase 5: Backend cleanup around config routes.**
   Only after the UI contract stabilizes should `server.js` and `config-model.js` be split further. Frontend goals can be met before broad server extraction.

This sequence minimizes the two biggest brownfield risks in PlexLite: schema drift between setup and settings, and accidental regression inside the 1,619-line `server.js`.

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 1 local operator on one appliance | Current monolith is fine; focus on UI clarity and smaller frontend modules |
| Several pages/features maintained by one team | Extract frontend shells/stores/renderers and config/admin routes so behavior changes stay local |
| Multi-user or remote-admin product evolution | Split `/api/status` and `/api/config` payloads more aggressively, harden auth/session handling, and consider a richer router only if navigation/state complexity justifies it |

### Scaling Priorities

1. **First bottleneck:** Change risk, not throughput. The main problem is that UI behavior is concentrated in large page scripts and backed by a giant schema file.
2. **Second bottleneck:** Contract drift. If setup and settings keep evolving separately, onboarding quality and expert controls will diverge quickly.

## Anti-Patterns

### Anti-Pattern 1: Big-Bang SPA Rewrite

**What people do:** Replace static HTML pages with a new framework, routing layer, and client-side state stack all at once.
**Why it's wrong:** PlexLite’s problem is information architecture, not a missing SPA runtime. A rewrite would spend risk budget on tooling and parity instead of solving navigation and disclosure.
**Do this instead:** Keep the current multi-page delivery model and introduce module boundaries, a small shared store, and sidebar/wizard shells inside it.

### Anti-Pattern 2: Duplicated Schema Logic Between Setup And Settings

**What people do:** Keep `settings.js` schema-driven while hardcoding wizard fields and validation separately in `setup.js`.
**Why it's wrong:** Brownfield onboarding drifts fast when field names, labels, defaults, or restart warnings change in one place but not the other.
**Do this instead:** Define first-run field subsets and disclosure metadata in or adjacent to `config-model.js`, then project them into both views.

### Anti-Pattern 3: Hiding Complexity With CSS Alone

**What people do:** Add collapsible panels and `display: none` rules on top of the current long page without changing state, deep links, or ownership boundaries.
**Why it's wrong:** Users still lose orientation, and developers still maintain one large rendering function with implicit coupling.
**Do this instead:** Introduce explicit ownership for shell, navigation, disclosure, and field rendering so the sidebar state and disclosure rules are first-class.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Victron Modbus/MQTT | Backend transport adapters only | The UI refactor should not talk to devices directly; keep hardware boundaries server-side |
| Energy Charts | Backend fetch feeding existing status/config views | No change required for sidebar/wizard work |
| InfluxDB | Backend optional sink | Keep out of onboarding except for one optional step/section |
| systemd service control | Existing admin endpoints | Expose restart requirements and health summaries, but keep service actions clearly separated from normal settings |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| `config-model` ↔ browser settings modules | `/api/config` JSON | Preserve this as the canonical schema boundary |
| `settings-store` ↔ renderers | `EventTarget` events plus explicit getters/actions | Simple enough for current app size and avoids framework lock-in |
| `history-state` ↔ shell/sidebar | `pushState`, `replaceState`, `popstate` | Enables deep links for sections and wizard steps |
| `setup-wizard` ↔ `settings-store` | Shared draft + shared validation helpers | Prevents schema drift |
| `server.js` ↔ extracted config/admin routes | Direct module imports | Safe backend cleanup only after UI contracts settle |

## Sources

- MDN, JavaScript modules: [https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)
- Node.js, ECMAScript modules: [https://nodejs.org/api/esm.html](https://nodejs.org/api/esm.html)
- MDN, `EventTarget`: [https://developer.mozilla.org/en-US/docs/Web/API/EventTarget](https://developer.mozilla.org/en-US/docs/Web/API/EventTarget)
- MDN, Working with the History API: [https://developer.mozilla.org/en-US/docs/Web/API/History_API/Working_with_the_History_API](https://developer.mozilla.org/en-US/docs/Web/API/History_API/Working_with_the_History_API)
- MDN, `<details>` element: [https://developer.mozilla.org/en-US/docs/Web/HTML/Element/details](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/details)
- WAI-ARIA Authoring Practices Guide, Accordion Pattern: [https://www.w3.org/WAI/ARIA/apg/patterns/accordion/](https://www.w3.org/WAI/ARIA/apg/patterns/accordion/)
- WAI-ARIA Authoring Practices Guide, Tabs Pattern: [https://www.w3.org/WAI/ARIA/apg/patterns/tabs/](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)
- U.S. Web Design System, Side navigation: [https://designsystem.digital.gov/components/side-navigation/](https://designsystem.digital.gov/components/side-navigation/)
- U.S. Web Design System, Step indicator: [https://designsystem.digital.gov/components/step-indicator/](https://designsystem.digital.gov/components/step-indicator/)
- MDN, `HTMLFormElement.reportValidity()`: [https://developer.mozilla.org/en-US/docs/Web/API/HTMLFormElement/reportValidity](https://developer.mozilla.org/en-US/docs/Web/API/HTMLFormElement/reportValidity)

---
*Architecture research for: PlexLite brownfield settings/navigation refactor*
*Researched: 2026-03-08*
