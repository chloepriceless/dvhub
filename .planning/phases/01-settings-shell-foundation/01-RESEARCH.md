# Phase 1 Research: Settings Shell Foundation

**Phase:** 1
**Name:** Settings Shell Foundation
**Researched:** 2026-03-08
**Status:** Complete

## Objective

Research what is needed to plan Phase 1 well: restructure the existing Settings page into a compact sidebar-driven shell without breaking the current schema-driven config model or accidentally pulling in later-phase concerns like setup-wizard redesign, expert disclosure rules, or risky-save UX.

## Current Repo Reality

The current Settings page is rendered in one long vertical document:

- `dv-control-webapp/public/settings.html` stacks header, status, summary, health, and the full settings form in one flow.
- `dv-control-webapp/public/settings.js` renders every section from `definition.sections` into `#settingsSections`.
- Each section becomes a full panel and each field group is wrapped in a `<details>` that is opened by default.
- `dv-control-webapp/config-model.js` already defines the section list and field metadata, making schema-driven rendering a strong existing asset.

This means the main problem is not missing infrastructure. The problem is that the current renderer exposes all sections sequentially and uses technical section names directly.

## Phase 1 Scope Guardrails

Phase 1 should only establish the new shell and information architecture:

- left sidebar navigation
- compact overview-first entry state
- right-hand section workspace
- task-oriented grouping and labels
- denser but calm layout

Phase 1 should explicitly avoid:

- redesigning `setup.html` / `setup.js`
- defining the full advanced/expert disclosure system
- implementing risky-save/restart/reconnect flows
- changing backend config semantics

## Recommended Architecture For This Phase

### 1. Keep the schema-driven settings model

Do not replace `getConfigDefinition()` or hand-write the form. The existing model in `dv-control-webapp/config-model.js` is the safest source of truth for section membership and field metadata.

Recommended planning assumption:

- keep the backend schema as the authoritative source
- add only the metadata needed for user-facing grouping/labels if current fields are insufficient
- move the shell/navigation logic into `public/settings.js`

### 2. Split shell concerns from field rendering

The current `renderDefinition()` function does too much at once. Phase 1 planning should assume an internal split such as:

- shell bootstrap
- sidebar model construction
- overview rendering
- active-section rendering
- field/group rendering

This can stay in one file initially if necessary, but the plan should aim for clear function boundaries.

### 3. Use app-like section swapping, not anchor scrolling

Because the user explicitly chose an app-like feel, the right workspace should swap content when the active sidebar item changes. Do not emulate the old page with a table of contents and jump links.

The planning implication is that active section state becomes a first-class concept in `settings.js`.

### 4. Preserve the top action area

The user decided that save/status/health should remain in a compact top header area. The sidebar is only for content navigation. Planning should preserve the current action model while making it denser and optionally sticky.

## Recommended User-Facing Section Taxonomy

The current technical sections are:

- `system`
- `victron`
- `meter`
- `points`
- `controlWrite`
- `dvControl`
- `schedule`
- `scan`
- `influx`
- `epex`

For Phase 1 planning, the best starting taxonomy is 5-6 user-facing groups:

| Proposed Group | Likely Existing Sources | Why it fits |
|----------------|-------------------------|-------------|
| Grundsystem | `system`, part of `schedule` | Core app/runtime defaults and general behavior |
| Verbindung | `victron`, `meter` | Plant/device connection setup is a clear user task |
| Direktvermarktung | `dvControl`, `controlWrite` | DV-related write/control behavior belongs together conceptually |
| Preise & Dienste | `epex`, `influx` | Optional service-like integrations and data services |
| Zeitplan | `schedule` | Distinct user task and already user-facing enough |
| Erweitert | `points`, `scan`, register-heavy leftovers | Technical and diagnostic content kept out of the core path |

Important planning note:

- This taxonomy should be treated as a strong default, not a locked final naming system.
- Plans should include a review of field-to-group mapping against the actual field inventory from `config-model.js`.

## Layout Patterns Worth Preserving

### Overview-first entry

The shell should open on a compact overview page before dropping into a specific settings section. This gives new users orientation and supports the user request for easier overview.

### Short section header

Each active section should start with:

- clear title
- one short orientation sentence
- the relevant settings immediately below

Avoid long explanatory blocks in Phase 1; the user explicitly wants less scrolling and more compactness.

### Two-column field layout where appropriate

On desktop, a two-column form layout is the right default for this phase. It improves scan speed without turning the page into a dense expert console. Mobile can collapse back to one column.

### Sticky navigation and action bar

The user chose sticky sidebar plus sticky save/action bar. This should be planned as a shell/layout concern, not as part of validation or save-logic redesign.

## State And Navigation Behavior

Phase 1 planning should include lightweight state behavior:

- default entry state = overview
- active section can change immediately via sidebar click
- active section is visibly highlighted
- last visited section may be remembered for convenience, but the page still starts from overview

This suggests a simple history/local-state approach, not a router:

- in-memory active section state
- optional `localStorage` or URL hash for "last opened"
- no SPA migration

## Implementation Risks Specific To This Repo

### Risk 1: letting taxonomy drift away from the actual schema

If the new sidebar model becomes a separate hard-coded structure with duplicated field membership, the shell will drift from `config-model.js`. Planning should either derive groups from schema metadata or centralize the mapping in one place.

### Risk 2: dragging Phase 3 concerns into Phase 1

Advanced/expert defaults, inherited summaries, and hidden-state semantics belong mostly to Phase 3. Phase 1 should not stall on perfect disclosure semantics.

### Risk 3: over-designing the shell

The goal is not a complex dashboard-within-dashboard. The shell should stay lean enough that the existing page can be refactored, not rewritten.

## Planning Implications

The roadmap already suggested 3 plans for this phase. Research supports that split:

### Plan A: Shell and active-section mechanics

Focus:

- sidebar state model
- overview-first landing
- active-section swapping
- sticky shell scaffolding

### Plan B: Taxonomy and user-facing grouping

Focus:

- map current technical sections into 5-6 user-facing groups
- update labels and intros
- ensure grouping remains compatible with `config-model.js`

### Plan C: Density and visual behavior

Focus:

- two-column layout where sensible
- tighter spacing and calmer information hierarchy
- compact action/header treatment

This split matches the user decisions and keeps each plan coherent.

## Recommended Sources To Lean On During Planning

- `dv-control-webapp/public/settings.html`
- `dv-control-webapp/public/settings.js`
- `dv-control-webapp/config-model.js`
- `.planning/phases/01-settings-shell-foundation/01-CONTEXT.md`
- `.planning/research/SUMMARY.md`

## Validation Architecture

Phase 1 needs fast feedback for both structure and user-visible behavior.

Recommended validation mix:

- extract pure helpers for section mapping / active-section state and cover them with `node:test`
- add a light browser smoke path for sidebar switching and overview rendering
- keep one manual check for layout density and sticky behavior across desktop/mobile sizes

### Suggested automated coverage targets

- section taxonomy builder returns the expected user-facing groups
- active section defaults to overview
- switching section updates the rendered workspace target
- current technical sections are all assigned to a visible user-facing group

### Suggested manual checks

- sidebar remains understandable on common desktop width
- sticky action bar does not hide important content
- compact layout still reads cleanly on smaller screens

## Sources

- `.planning/research/SUMMARY.md` - project-level research and roadmap implications
- `.planning/research/ARCHITECTURE.md` - existing architectural seams and frontend refactor direction
- `.planning/research/FEATURES.md` - expected UX features and anti-features for beginner-friendly settings
- `dv-control-webapp/public/settings.html` - current shell structure
- `dv-control-webapp/public/settings.js` - current schema-driven renderer and dominant refactor target
- `dv-control-webapp/config-model.js` - current section metadata and form model authority

---
*Phase research completed: 2026-03-08*
