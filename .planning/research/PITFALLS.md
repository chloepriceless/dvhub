# Pitfalls Research

**Domain:** Brownfield beginner-first setup and settings UX for a Victron ESS control bridge
**Researched:** 2026-03-08
**Confidence:** HIGH

## Critical Pitfalls

### Pitfall 1: Splitting the source of truth between the wizard and the schema-driven settings page

**What goes wrong:**
The beginner setup flow becomes easier to scan, but it silently drifts away from the real config model. New defaults, restart-sensitive fields, inherited values, or integration requirements get updated in `dv-control-webapp/config-model.js` and `public/settings.js`, while `public/setup.js` keeps a hand-maintained subset. Beginners complete setup successfully, then hit confusing behavior in Settings, Import, or runtime startup because the wizard no longer represents the real product.

**Why it happens:**
PlexLite already has two config UIs with different implementation models: `public/settings.js` renders from `/api/config` definition metadata, while `public/setup.js` hard-codes field collection and save behavior. In a brownfield product, teams often simplify the first-run flow by duplicating logic instead of extending the schema with "beginner", "advanced", "required for transport X", or "dangerous" metadata.

**How to avoid:**
Make `config-model.js` the only source of truth for field presence, defaulting, validation, and beginner/expert visibility. Add per-field metadata for setup step, beginner priority, transport dependency, and risk level, then render both Setup and Settings from that metadata. Treat any hard-coded setup-only field list as temporary debt with explicit tests.

**Warning signs:**
Setup exposes fields that Settings labels differently, imported configs produce unexpected inherited values, save responses mention restart-required paths the wizard never explained, or changes to `config-model.js` require manual edits in `public/setup.js`.

**Phase to address:**
Phase 1: Config schema and information architecture foundation before visual simplification.

---

### Pitfall 2: Hiding expert settings without first showing transport and service eligibility

**What goes wrong:**
The UI gets cleaner, but beginners still pick the wrong transport, omit required network details, or save MQTT/Modbus combinations that cannot work on the target GX device. The result is a shorter form that still ends in a non-working plant connection, just with fewer clues about why.

**Why it happens:**
In technical products, "advanced" often gets conflated with "rare". For PlexLite, some low-frequency settings are still critical prerequisites: Victron transport choice, GX service enablement, host/port/unit ID, MQTT portal ID, schedule timezone, and API token strategy. GOV.UK's guidance for complex services recommends a "check if this is suitable" flow and asking only the questions needed at that moment, but only after working out eligibility and prerequisites early.

**How to avoid:**
Add a short preflight step before the wizard proper: choose Modbus or MQTT, confirm the GX-side service is enabled, collect only the minimum transport-specific fields, then show a result/summary of what PlexLite will expect next. Keep advanced protocol tuning hidden, but never hide prerequisites that determine whether setup can succeed.

**Warning signs:**
Support incidents that start with "setup saved but nothing updates", repeated edits to transport fields after first save, or user confusion about why MQTT-specific fields appear or disappear without explanation.

**Phase to address:**
Phase 2: First-run suitability and transport preflight before the full guided setup.

---

### Pitfall 3: Treating config saves as harmless UI edits when they can lock the operator out

**What goes wrong:**
Beginners change `apiToken`, `httpPort`, `modbusListenHost`, `modbusListenPort`, or `victron.transport`, click save, and lose access or interrupt automation. A simplified UI can make this worse if it hides consequences behind friendly labels and a single save button.

**Why it happens:**
PlexLite's config save path writes directly to the live config, returns `restartRequired`, and exposes admin restart actions from the same web app. W3C and GOV.UK both recommend confirmation and correction paths for important submissions, but brownfield settings pages often preserve a "save now" interaction model even when changes affect connectivity, access control, or hardware control.

**How to avoid:**
Add a review step for high-impact changes, especially auth, ports, transport, and control-write mappings. Show "you may need to reconnect on a new URL/token" before commit. Offer export or rollback guidance before applying risky changes. Keep a post-save reconnect path that can survive token or port updates.

**Warning signs:**
Restart-sensitive saves appear in one flat confirmation banner, the UI says "saved" before the user understands the impact, or users must recover from an exported file or shell access after changing auth/network settings.

**Phase to address:**
Phase 3: Safe apply, confirmation, and reconnect/recovery UX for risky settings.

---

### Pitfall 4: Relying on shallow client-side parsing instead of authoritative server-side validation

**What goes wrong:**
The beginner UI accepts values that are syntactically present but operationally useless, ambiguous, or unsafe. Examples in this repo include invalid register layouts, missing MQTT prerequisites, schedule fields that look supported but are not honored consistently, and write targets that pass "number" checks but still create bad plant behavior.

**Why it happens:**
`public/setup.js` and `public/settings.js` coerce inputs with `Number(...)`, booleans, and strings, but the backend only applies uneven validation across routes. The codebase map already shows no automated test harness and several shallow endpoint guards. Simplifying the UI without tightening the backend turns form polish into a false sense of safety.

**How to avoid:**
Define server-side validation contracts per field and per workflow. Return field-level errors, keep the user's inputs on screen, and validate dangerous changes against transport-specific rules. Add smoke tests for config normalization, auth, schedule semantics, and control-write bounds before broad UI refactors.

**Warning signs:**
Save succeeds but runtime transport init fails, values are silently normalized in ways users did not expect, or frontend and backend disagree on what fields are required or what formats are allowed.

**Phase to address:**
Phase 1 and Phase 3: validation contracts first, confirmation UX second.

---

### Pitfall 5: Breaking protocol semantics while "simplifying" register and integration settings

**What goes wrong:**
The product hides register-level detail from beginners, but also removes the context experts need to diagnose field mapping, keep-alive behavior, or service-side constraints. The app then appears broken because the UI no longer explains what Modbus/MQTT actually needs.

**Why it happens:**
PlexLite is not just a dashboard. It is a protocol bridge between a DV-facing Modbus server and a Victron Modbus or MQTT upstream. Victron's official Modbus docs call out service enablement and non-contiguous register issues, and Victron's MQTT docs require explicit keep-alive behavior for topic discovery on modern Venus OS. These are domain rules, not optional implementation details.

**How to avoid:**
Hide raw register tuning by default, but keep an explicit "connection details" and "expert diagnostics" path. Add live tests for transport reachability, service enabled status, portal ID, and a keep-alive-backed MQTT sanity check. Preserve deep links from beginner pages to the exact expert section that explains a failure.

**Warning signs:**
Users cannot tell whether the fault is in PlexLite, the GX service configuration, a wrong unit ID, a non-existent Modbus register block, missing MQTT keep-alive, or a broker/network problem.

**Phase to address:**
Phase 4: Integration diagnostics and expert escape hatches after the beginner flow is stable.

---

### Pitfall 6: Re-skinning the page while leaving coupling and missing tests untouched

**What goes wrong:**
The UI looks more compact and guided, but regressions appear in save/import/export, restart banners, health checks, or dashboard behavior because the frontend still depends directly on backend payload shapes and there is no regression suite.

**Why it happens:**
PlexLite's browser pages are plain HTML/JS entry points, and `server.js` plus `config-model.js` are large, shared control centers. Any navigation/sidebar/workflow refactor can change assumptions around `/api/config`, `/api/admin/health`, restart-required paths, or imported raw config objects. Without automated tests, the team finds drift only after manual runs on live-like hardware.

**How to avoid:**
Do not treat this as a CSS-only roadmap item. Budget a phase for route-contract verification, config save/import smoke tests, and a small browser flow suite around Setup, Settings, and risky save paths. Extract or document contracts before moving more UI logic around.

**Warning signs:**
Refactors require synchronized edits across `server.js`, `config-model.js`, `public/settings.js`, and `public/setup.js`, or the only verification plan is "open the page and click around."

**Phase to address:**
Phase 5: Regression safety net and contract hardening before broader UX expansion.

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Keep `public/setup.js` as a hand-maintained subset instead of extending schema metadata | Faster initial wizard redesign | Guaranteed drift between setup, settings, import/export, and restart messaging | Only as a short-lived bridge with a clear removal phase |
| Hide advanced fields with CSS or collapsed sections only | Cleaner first impression | Dangerous fields still serialize, import/export stays opaque, and users cannot tell what is active underneath | Never for safety-critical or restart-sensitive fields |
| Continue appending auth tokens via query strings and persisting them in `localStorage` | Easy sharing and reconnect behavior | Token leakage in URLs/history and long-lived browser persistence | Never for production defaults |
| Keep save/import endpoints returning the full effective config including secrets to any authenticated UI | Simplifies frontend rendering | No separation between "operator can monitor" and "operator can exfiltrate secrets" | Only in a trusted single-user local deployment, and still should be documented as debt |
| Refactor navigation without adding tests around `/api/config`, restart-required paths, and transport startup | Faster visible progress | Hidden regressions in a hardware-control product | Never once roadmap work reaches rollout stages |

## Integration Gotchas

Common mistakes when connecting to external services.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Victron Modbus TCP | Assume the service is enabled and register ranges are safely queryable as one block | Surface GX-side service enablement in setup, validate unit ID/address combinations, and explain that non-existing registers in a range can fail the query |
| Victron MQTT / Venus OS | Assume subscription alone is enough to discover values | Issue and verify keep-alive behavior, explain portal ID requirements, and show whether the broker is reachable before claiming setup success |
| DV-facing Modbus bridge | Simplify UI labels without preserving the mapping between control intent and actual register writes | Keep beginner labels human-readable, but preserve inspectable raw mappings and change summaries for experts |
| InfluxDB | Treat URL/token/bucket as "optional telemetry extras" without format or auth feedback | Validate required fields together, warn about auth headers, and escape/format payloads consistently before enabling writes |
| Energy Charts / EPEX | Assume fetched prices and schedule timezone semantics are self-evident | Explain data source, timezone assumptions, and stale-data state in the UI; verify negative-price dependent features against actual feed freshness |

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Add live validation/network checks on every keystroke | Slow form typing, repeated network errors, noisy logs | Validate on step continue/save, with explicit test buttons for transport checks | Breaks quickly on weak GX or network links |
| Keep all settings groups rendered and expanded while adding more explanatory content | Long DOM trees, more scrolling, harder orientation despite the redesign | Use sidebar navigation, per-section mounting, and progressive disclosure tied to actual user goals | Breaks as soon as sections gain more helper copy and status rows |
| Re-fetch full config and health payloads after every minor save | UI feels laggy and reconnects unpredictably | Separate lightweight validation/status endpoints from full definition payloads | Noticeable on lower-end devices and remote connections |
| Keep broad `/api/status` polling patterns as the basis for future setup diagnostics | Extra CPU/network work and coupling between dashboard and setup logic | Add narrow diagnostics endpoints for setup health rather than reusing dashboard payloads | Breaks with multiple concurrent browser sessions |

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Using `?token=` links as a normal operator workflow | Credentials leak via URLs, copied links, logs, and browser history | Prefer header-based auth, one-time setup tokens, or a local login step; treat URL tokens as recovery-only if kept at all |
| Persisting the API token in `localStorage` by default | Long-lived credential exposure to any script running on the origin and across browser restarts | Minimize token lifetime, avoid persistent browser storage for privileged tokens, and separate monitor vs admin access where possible |
| Leaving `apiToken` blank in beginner-friendly defaults | Local network users can reach config, writes, scans, and restart actions without auth | Force an explicit auth decision during setup and warn when the install remains open |
| Exposing full config and service actions in the same beginner UI | A novice operator can accidentally trigger privileged host or plant changes | Separate risky actions, add confirmations, and reduce secret exposure in normal monitoring paths |

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Presenting transport setup as a long generic form instead of a decision flow | Beginners do not know whether they should use Modbus or MQTT | Start with a short suitability/preflight choice, then show transport-specific steps |
| Grouping by internal subsystem names only (`points`, `controlWrite`, `dvControl`) | Users cannot map labels to real-world tasks | Group by user goal first, with expert/internal labels as secondary detail |
| Collapsing advanced sections without stating what is hidden or inherited | Users assume a setting is off when it is merely hidden or inherited | Show concise summaries of inherited values, active defaults, and hidden advanced state |
| Showing one generic success banner after risky saves | Users think the job is complete even when restart, reconnect, or verification is still required | Use step-specific outcome pages with next actions and verification status |
| Moving schedule and diagnostics behavior out of sight without adding explanation | Users blame the beginner UI when automation behaves unexpectedly later | Keep contextual links to schedule rules, diagnostics, and live health from the relevant setup step |

## "Looks Done But Isn't" Checklist

- [ ] **Setup wizard:** Uses the same field metadata and validation rules as `config-model.js` rather than a second field inventory.
- [ ] **Transport setup:** Verifies the chosen Modbus/MQTT path with a real connectivity check before claiming success.
- [ ] **Risky save flow:** Clearly explains restart-required changes, reconnect implications, and how to recover if access changes.
- [ ] **Advanced settings:** Hidden fields still have visible summaries for inherited/default values that materially affect behavior.
- [ ] **Import/export:** Beginner flows preserve compatibility with raw config import/export and do not strip required expert settings.
- [ ] **Schedule UX:** The UI explains which schedule semantics are supported now versus planned later, especially for day/one-time behavior.
- [ ] **Security posture:** Setup forces an explicit choice about local auth instead of silently inheriting an open deployment.
- [ ] **Regression safety:** There are automated smoke checks for save, import, restart-required detection, and transport startup.

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Wizard/schema drift | MEDIUM | Reconcile Setup against `config-model.js`, add schema metadata for the missing concept, and backfill tests for save/import parity |
| Lockout after auth or port changes | HIGH | Restore access through exported config or shell access, then add a reconnect-aware save/review step before re-releasing |
| Hidden integration prerequisite | MEDIUM | Add a preflight/result screen, GX-side checklist, and targeted diagnostics link instead of more generic helper text |
| Validation mismatch between browser and server | MEDIUM | Move the rule to the backend contract, return field-level errors, and remove conflicting client assumptions |
| UI-only refactor regressions | HIGH | Freeze new UX changes, add route/save smoke tests, and re-verify Setup, Settings, and transport startup on real or simulated hardware |

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Split source of truth between wizard and schema | Phase 1: Config schema and IA foundation | Setup and Settings render from shared metadata; save/import parity tests pass |
| Hidden transport prerequisites | Phase 2: Suitability and transport preflight | A new user can reach a working transport config without seeing irrelevant fields |
| Risky saves without review/recovery | Phase 3: Safe apply and reconnect UX | Changing token/port/transport gives a review screen plus a recoverable reconnect path |
| Weak validation on high-impact settings | Phase 1 and Phase 3 | Invalid or unsafe inputs are rejected server-side with actionable field-level feedback |
| Protocol semantics lost during simplification | Phase 4: Diagnostics and expert escapes | Users can distinguish bad PlexLite config from GX service, register, or MQTT issues |
| UI refactor without regression coverage | Phase 5: Test and contract hardening | Smoke tests cover `/api/config`, import/export, restart-required detection, and transport startup |

## Sources

- GOV.UK Design System, "Question pages": https://design-system.service.gov.uk/patterns/question-pages/
- GOV.UK Design System, "Check a service is suitable": https://design-system.service.gov.uk/patterns/check-a-service-is-suitable/
- GOV.UK Design System, "Check answers": https://design-system.service.gov.uk/patterns/check-answers/
- GOV.UK Design System, "Recover from validation errors": https://design-system.service.gov.uk/patterns/validation/
- U.S. Web Design System, "Form": https://designsystem.digital.gov/components/form/
- W3C WAI, "Understanding Success Criterion 3.3.4 Error Prevention (Legal, Financial, Data)": https://www.w3.org/WAI/WCAG22/Understanding/error-prevention-legal-financial-data
- MDN, "Security on the web": https://developer.mozilla.org/en-US/docs/Web/Security
- MDN, "`window.localStorage`": https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage
- Victron Energy, "GX Modbus-TCP Manual": https://www.victronenergy.com/live/ccgx:modbustcp_faq
- Victron Energy GitHub, "dbus-flashmq": https://github.com/victronenergy/dbus-flashmq
- InfluxData, "Write data with the InfluxDB API": https://docs.influxdata.com/influxdb/v2/write-data/developer-tools/api/
- InfluxData, "Line protocol": https://docs.influxdata.com/influxdb/v2/reference/syntax/line-protocol/
- Energy-Charts API: https://energy-charts.info/api.html
- Energy-Charts data sources: https://energy-charts.info/2014/sources.htm

---
*Pitfalls research for: brownfield beginner-first setup and settings UX in PlexLite*
*Researched: 2026-03-08*
