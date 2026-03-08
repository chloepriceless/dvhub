# Feature Research

**Domain:** Beginner-friendly setup and settings UX for a technical local admin UI
**Researched:** 2026-03-08
**Confidence:** HIGH

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels incomplete.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Task-oriented settings navigation | Users need to find the right settings area without scanning one long page | MEDIUM | A persistent left sidebar grouped by real-world tasks is the clearest fit for PlexLite |
| Guided first-run setup | New users expect a path that explains only what is needed to get started | MEDIUM | Best delivered as a step-based wizard over the same config model |
| Progressive disclosure for expert settings | Technical products are expected to hide rare or risky details until needed | MEDIUM | Modbus registers, special write mappings, and diagnostics should be collapsed by default |
| Clear save and restart feedback | Users expect to know whether changes are active, risky, or need a restart | MEDIUM | Especially important for token, port, transport, and service changes |
| Contextual help and defaults | Beginners need labels, hints, and sensible prefilled values at the point of action | LOW | Existing schema help can be expanded and surfaced more intentionally |
| Transport-specific forms | Users expect the UI to adapt when they choose Modbus vs MQTT | MEDIUM | Avoid showing irrelevant fields until the transport choice is known |
| Validation that explains what to fix | A simplified UI still needs actionable feedback for invalid inputs | MEDIUM | Server-side validation must remain authoritative; client-side should guide, not guess |
| Safe path to expert detail | Advanced users still expect full control without fighting the beginner mode | MEDIUM | Deep links, disclosures, and diagnostics should preserve access to raw detail |

### Differentiators (Competitive Advantage)

Features that set the product apart. Not required, but valuable.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Sidebar with section summaries | Users see both structure and the current area at a glance | MEDIUM | Can show short captions, status badges, or counts for hidden advanced fields |
| Transport preflight before full setup | Prevents users from filling a long form before knowing whether their setup path is valid | MEDIUM | Strong fit for the Modbus/MQTT split in PlexLite |
| Inherited/default value summaries | Beginners understand what is active even when expert fields stay hidden | MEDIUM | Especially useful for fields with delete/inherit semantics |
| Risk-aware save review | Explains when a change affects connectivity, auth, or service restarts before applying it | HIGH | High value because PlexLite can lock users out with a single save |
| Diagnostics links from relevant steps | Keeps setup approachable while preserving a fast escape hatch for troubleshooting | MEDIUM | Bridges beginner and expert workflows without crowding the main UI |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but create problems.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| One giant "all settings on one page" form | Feels simple to implement and exposes everything at once | Creates scroll fatigue, weak orientation, and high beginner anxiety | Sidebar plus section viewport with advanced disclosures |
| Smart auto-detection with little explanation | Sounds beginner-friendly | Hard to trust when it fails; difficult to recover from in a hardware/network environment | Explicit preflight with clear checks and explanations |
| Separate setup logic disconnected from settings schema | Seems faster than refactoring shared metadata | Drifts over time and creates inconsistent labels, defaults, and validation | Shared schema with setup-specific filtering and step metadata |
| Full SPA rewrite as the first UX step | Feels like a clean slate | High regression risk, large scope increase, does not directly solve information architecture | Incremental refactor inside the current multi-page app |
| Showing raw register editors in the beginner path | Experts want maximum control | Overwhelms new users and encourages unsafe edits | Keep raw detail under expert disclosures and diagnostics |

## Feature Dependencies

```text
Task-oriented navigation
    └──requires──> Shared section metadata
                          └──requires──> Config schema cleanup

Guided setup wizard
    └──requires──> Shared draft store
                          └──requires──> Server-side validation contract

Expert disclosures
    └──requires──> Field audience metadata
                          └──enhances──> Compact section layout

Risk-aware save review
    └──requires──> Restart-sensitive path detection
                          └──enhances──> Reconnect/recovery UX

Diagnostics links
    └──enhances──> Setup wizard
    └──enhances──> Expert settings path
```

### Dependency Notes

- **Task-oriented navigation requires shared section metadata:** the sidebar should be derived from schema sections, not maintained in a second structure that will drift.
- **Guided setup requires a shared draft store:** setup and settings must edit the same config model or the product will split into two different truths.
- **Expert disclosures require field audience metadata:** otherwise "basic" and "advanced" become ad hoc CSS decisions and are hard to maintain.
- **Risk-aware save review requires restart-sensitive path detection:** PlexLite already detects this backend-side, so the UI should reuse it rather than inventing its own risk logic.
- **Diagnostics links enhance setup and expert settings:** they should not replace the main path, but they prevent dead ends when something fails.

## MVP Definition

### Launch With (v1)

Minimum viable product for this UX milestone.

- [ ] Left sidebar navigation for Settings with clearly named sections
- [ ] Compact section-focused settings layout instead of one long scrolling page
- [ ] Advanced and expert options collapsed by default, including register-heavy sections
- [ ] Guided first-run setup wizard with a limited number of fields per step
- [ ] Transport-specific field visibility and clearer explanations for required inputs
- [ ] Save flow that clearly communicates restart-required and risky changes
- [ ] Shared labels/help/defaults across Setup and Settings

### Add After Validation (v1.x)

- [ ] Transport preflight checks before completing setup - add after the core structure is stable
- [ ] Section summaries showing inherited/default values - add when beginner hiding works reliably
- [ ] Contextual links from setup steps to diagnostics and expert sections - add once navigation is settled
- [ ] Better post-save recovery guidance for token/port changes - add after the safe-apply flow is in place

### Future Consideration (v2+)

- [ ] Settings search and quick jump - useful once the new IA has proven stable
- [ ] User-selectable beginner/expert display modes - only if real usage shows a need
- [ ] Preset templates for common Victron/LUOX setups - valuable, but depends on stronger validation and hardware assumptions
- [ ] Inline documentation overlays or tours - defer until the core IA no longer shifts

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Sidebar navigation | HIGH | MEDIUM | P1 |
| Compact section layout | HIGH | MEDIUM | P1 |
| Advanced/expert disclosures | HIGH | MEDIUM | P1 |
| Guided setup wizard | HIGH | MEDIUM | P1 |
| Transport-specific visibility | HIGH | MEDIUM | P1 |
| Save/restart clarity | HIGH | MEDIUM | P1 |
| Shared schema-driven labels/help | HIGH | MEDIUM | P1 |
| Transport preflight | HIGH | MEDIUM | P2 |
| Diagnostics links | MEDIUM | MEDIUM | P2 |
| Inherited/default summaries | MEDIUM | MEDIUM | P2 |
| Settings search | MEDIUM | HIGH | P3 |
| Beginner/expert mode toggle | MEDIUM | MEDIUM | P3 |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

## Competitor Feature Analysis

| Feature | Competitor A | Competitor B | Our Approach |
|---------|--------------|--------------|--------------|
| Guided setup | PatternFly-style wizard patterns emphasize step-by-step completion for complex tasks | GOV.UK patterns emphasize simple questions and explicit result pages | Use a guided setup with short steps, but keep it local-app and config-oriented rather than service-application oriented |
| Section navigation | PatternFly navigation is optimized for task finding and structure visibility | Many local admin tools still rely on long forms or top tabs | Use a persistent left sidebar because PlexLite has many categories and users already asked for a Vivaldi-like left navigation feel |
| Disclosure of complexity | W3C accordion guidance supports reducing scroll for many sections | Many technical products expose all expert fields immediately | Use accordions/details for advanced and register-heavy content, but keep essential prerequisites visible |
| Eligibility/preflight | GOV.UK suitability flows check if a service is right before the full journey begins | Technical setup tools often skip this and let users fail later | Add a short transport/suitability preflight once the core wizard is stable |

## Sources

- [PatternFly: Navigation](https://www.patternfly.org/components/navigation/) - supports centralized structure and task finding for complex applications
- [PatternFly: Wizard](https://www.patternfly.org/components/wizard/) - supports guided multi-step completion for complex tasks
- [GOV.UK Design System: Question pages](https://design-system.service.gov.uk/patterns/question-pages/) - supports asking only what is needed and focusing users one decision at a time
- [GOV.UK Design System: Check a service is suitable](https://design-system.service.gov.uk/patterns/check-a-service-is-suitable/) - supports early suitability/preflight flows
- [W3C WAI-ARIA APG: Accordion Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/accordion/) - supports reducing scroll while keeping sections accessible
- [.planning/PROJECT.md](/Volumes/My%20Shared%20Files/CODEX/Plexlite/.planning/PROJECT.md) - project-specific goals and non-goals
- [.planning/codebase/ARCHITECTURE.md](/Volumes/My%20Shared%20Files/CODEX/Plexlite/.planning/codebase/ARCHITECTURE.md) - current codebase structure and constraints

---
*Feature research for: PlexLite setup/settings UX improvements*
*Researched: 2026-03-08*
