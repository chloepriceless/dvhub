# Roadmap: PlexLite

## Overview

Diese Roadmap fuehrt PlexLite von einer funktional starken, aber in Setup und Settings zu komplexen Webapp zu einer deutlich einsteigerfreundlicheren UX. Der Schwerpunkt liegt auf klarer Informationsarchitektur, einem gefuehrten Setup, progressiver Offenlegung fuer Expertenoptionen und sicheren Save-/Restart-Flows, ohne die bestehende Brownfield-Architektur unnoetig neu zu schreiben.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Settings Shell Foundation** - Build the compact sidebar-based information architecture for Settings.
- [ ] **Phase 2: Guided Setup Rebuild** - Turn first-run setup into a step-by-step beginner flow.
- [ ] **Phase 3: Progressive Disclosure Model** - Separate essential, optional, and expert settings with clear expandable structure.
- [ ] **Phase 4: Safe Apply And Recovery UX** - Make risky saves explain restart, reconnect, and validation consequences.
- [ ] **Phase 5: Diagnostics And Regression Hardening** - Expose expert escape hatches safely and protect the new flows with tests.

## Phase Details

### Phase 1: Settings Shell Foundation
**Goal**: Deliver a compact Settings shell with a persistent left sidebar, section-focused rendering, and clearer task-oriented labels for the main configuration areas.
**Depends on**: Nothing (first phase)
**Requirements**: [NAV-01, NAV-02, NAV-03, UX-01, UX-02]
**Success Criteria** (what must be TRUE):
  1. User can navigate the Settings UI through a fixed sidebar with clearly named sections.
  2. User sees one primary settings section at a time instead of scrolling through the full configuration surface.
  3. The active section is visibly highlighted and direct switching between sections works reliably.
  4. The layout is noticeably more compact on common desktop sizes, reducing total scroll distance for core settings work.
  5. Major settings sections use task-oriented wording that is easier to understand than internal-only technical labels.
**Plans**: 3 plans

Plans:
- [x] 01-01: Refactor settings page structure into a sidebar shell with active-section state
- [x] 01-02: Reorganize top-level section taxonomy and task-oriented labels
- [x] 01-03: Tighten layout density and section-level rendering behavior

### Phase 2: Guided Setup Rebuild
**Goal**: Replace the current broad setup page with a guided wizard that shows only the essential fields for each step and adapts to the chosen transport.
**Depends on**: Phase 1
**Requirements**: [SET-01, SET-02, SET-03, SET-04]
**Success Criteria** (what must be TRUE):
  1. User can move through setup in clear sequential steps with a small set of fields per screen.
  2. Setup fields change appropriately when the user selects Modbus or MQTT.
  3. User cannot continue past invalid required inputs without actionable feedback.
  4. User can review the most important setup values before the final save.
**Plans**: 3 plans

Plans:
- [ ] 02-01: Extract shared setup draft handling and wizard step state
- [ ] 02-02: Build transport-aware setup steps with beginner-focused copy
- [ ] 02-03: Add setup review step and save integration

### Phase 3: Progressive Disclosure Model
**Goal**: Introduce a consistent visibility model that distinguishes essential, optional, and expert settings while keeping hidden advanced details understandable and reachable.
**Depends on**: Phase 2
**Requirements**: [DISC-01, DISC-02, DISC-03, UX-03]
**Success Criteria** (what must be TRUE):
  1. Advanced and expert settings are collapsed by default in Settings.
  2. Register-heavy and expert-only areas can be expanded on demand without breaking the main flow.
  3. Hidden areas show concise summaries or inherited/default state when that affects real behavior.
  4. The page structure itself makes it clear which settings are essential, optional, or expert-level.
**Plans**: 2 plans

Plans:
- [ ] 03-01: Extend config metadata with audience and disclosure semantics
- [ ] 03-02: Render expandable expert sections with summaries for hidden state

### Phase 4: Safe Apply And Recovery UX
**Goal**: Make saves safer by surfacing restart requirements, risky connectivity changes, and actionable validation/recovery feedback before and after apply.
**Depends on**: Phase 3
**Requirements**: [SAFE-01, SAFE-02, SAFE-03]
**Success Criteria** (what must be TRUE):
  1. User sees explicit warnings when a change requires restart or reconnection.
  2. User is warned before saving changes that can affect access, connectivity, or transport behavior.
  3. Validation failures preserve user input and show clear next actions for correction.
  4. Save outcomes explain what happened and what the user should do next.
**Plans**: 2 plans

Plans:
- [ ] 04-01: Add risky-change review and restart/reconnect messaging
- [ ] 04-02: Improve validation error handling and post-save outcome states

### Phase 5: Diagnostics And Regression Hardening
**Goal**: Preserve expert escape hatches from the new beginner UX and add regression coverage for setup/settings/save flows.
**Depends on**: Phase 4
**Requirements**: [SAFE-04]
**Success Criteria** (what must be TRUE):
  1. User can reach diagnostics or expert detail from the relevant beginner context without getting lost.
  2. The new Settings and Setup flows retain access to deeper troubleshooting paths when needed.
  3. Automated smoke coverage exists for the most critical setup/settings journeys.
**Plans**: 2 plans

Plans:
- [ ] 05-01: Add contextual diagnostics and expert escape hatches
- [ ] 05-02: Add regression coverage for setup, settings, and save flows

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Settings Shell Foundation | 3/3 | Complete | 2026-03-08 |
| 2. Guided Setup Rebuild | 0/3 | Not started | - |
| 3. Progressive Disclosure Model | 0/2 | Not started | - |
| 4. Safe Apply And Recovery UX | 0/2 | Not started | - |
| 5. Diagnostics And Regression Hardening | 0/2 | Not started | - |
