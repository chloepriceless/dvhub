# Requirements: PlexLite

**Defined:** 2026-03-08
**Core Value:** Auch ein unerfahrener Nutzer soll PlexLite ohne Ueberforderung einrichten und die richtigen Einstellungen schnell finden koennen.

## v1 Requirements

### Navigation

- [x] **NAV-01**: User can open a fixed settings sidebar with clearly named main sections instead of navigating one long settings page.
- [x] **NAV-02**: User can focus on one settings section at a time without scrolling through unrelated settings blocks.
- [x] **NAV-03**: User can always see which settings section is active and switch directly to another section.

### Setup

- [ ] **SET-01**: User can complete first-run setup through a guided step-by-step flow with only the most important fields visible at each step.
- [ ] **SET-02**: User sees different setup fields depending on whether Victron transport is set to Modbus or MQTT.
- [ ] **SET-03**: User receives clear validation feedback before advancing to the next setup step or saving the setup.
- [ ] **SET-04**: User can review the key setup values before final save.

### Progressive Disclosure

- [ ] **DISC-01**: User sees advanced and expert settings collapsed by default in the Settings UI.
- [ ] **DISC-02**: User can expand detailed Modbus register and expert-only areas only when needed.
- [ ] **DISC-03**: User can understand when hidden settings inherit defaults or contain advanced values that still affect behavior.

### Clarity And Density

- [ ] **UX-01**: User sees a more compact settings layout that reduces scrolling and improves overview on common desktop sizes.
- [ ] **UX-02**: User sees settings labels and short helper text organized by user task rather than only by internal technical terminology.
- [ ] **UX-03**: User can understand which settings are essential, optional, or expert-level from the page structure itself.

### Safety And Feedback

- [ ] **SAFE-01**: User receives a clear warning when a saved settings change requires a service restart or reconnection.
- [ ] **SAFE-02**: User receives a clear warning before saving changes that can affect access, connectivity, or transport behavior.
- [ ] **SAFE-03**: User keeps entered values visible when validation fails and sees actionable error messages for correction.
- [ ] **SAFE-04**: User can reach diagnostics or expert detail from the relevant setup/settings context without leaving the product blind.

## v2 Requirements

### Convenience

- **CONV-01**: User can search settings by keyword and jump directly to matching sections or fields.
- **CONV-02**: User can switch between beginner and expert display modes explicitly.
- **CONV-03**: User can start from predefined setup templates for common deployment scenarios.

### Guidance

- **GUID-01**: User sees automated transport preflight checks before entering the full setup flow.
- **GUID-02**: User sees contextual walkthroughs or inline tours for first-time onboarding.

## Out of Scope

| Feature | Reason |
|---------|--------|
| New DV, Modbus, MQTT, EPEX, or energy optimization capabilities | Current milestone is about accessibility and structure, not expanding product capability |
| Full frontend framework rewrite | High migration risk and not necessary to solve the current UX problem |
| Replacement of Tools with a beginner-facing guided diagnostic product | Valuable later, but not necessary for the first usability milestone |
| Large new visual branding initiative | The priority is clarity, density, and structure rather than a separate brand redesign effort |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| NAV-01 | Phase 1 | Complete |
| NAV-02 | Phase 1 | Complete |
| NAV-03 | Phase 1 | Complete |
| SET-01 | Phase 2 | Pending |
| SET-02 | Phase 2 | Pending |
| SET-03 | Phase 2 | Pending |
| SET-04 | Phase 2 | Pending |
| DISC-01 | Phase 3 | Pending |
| DISC-02 | Phase 3 | Pending |
| DISC-03 | Phase 3 | Pending |
| UX-01 | Phase 1 | Pending |
| UX-02 | Phase 1 | Pending |
| UX-03 | Phase 3 | Pending |
| SAFE-01 | Phase 4 | Pending |
| SAFE-02 | Phase 4 | Pending |
| SAFE-03 | Phase 4 | Pending |
| SAFE-04 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 17 total
- Mapped to phases: 17
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-08*
*Last updated: 2026-03-08 after initial definition*
