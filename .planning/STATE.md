# DVhub Project State

## Current Phase
Phase 1: DV-Mehrerlös vs Einspeisevergütung — Plan 2/N complete

## Current Plan
Plan 3 (next)

## Progress
Phase 1: 2 plan(s) complete

## Accumulated Context

### Roadmap Evolution
- Phase 1 added: Historie: DV-Mehrerlös vs Einspeisevergütung berechnen (anzulegender Wert, Negativpreis-Regelungen, gesetzliche Grundlagen je Inbetriebnahmedatum)

## Decisions

### Phase 1 — Plan 1: EEG Rules + BNetzA Extension
- isRoundedFullFeedLabel exported (plan spec); isRoundedPartialFeedLabel remains private
- selectApplicableValueCtKwh changed to named export so plan 02 can import it for DV comparison
- getFeedInCompensationCtKwh: explicit null check before Number() coercion (Number(null)===0 is finite)
- feedType='partial' default on all BNetzA lookup functions for full backward compatibility
- 72 pre-existing test failures confirmed unrelated via stash test — no regressions introduced

### Phase 1 — Plan 2: DV Comparison KPI Calculation
- hypFullFeedInCtTotal/hypSurplusFeedInCtTotal excluded from AGGREGATE_SUM_FIELDS to preserve null semantics (finalizeAggregateSums would convert null to 0)
- awFullCtKwh uses explicit null check before Number() coercion (Number(null)===0 bug, same pattern as Plan 01)
- Test getCurrentDate set to future date to avoid history/live split causing duplicate slots
- dvCostEur year view counts distinct months with exportKwh > 0 (not hardcoded 12)

## Session Info
- Last session: 2026-03-25T00:35:00Z
- Stopped at: Completed 01-02-PLAN.md
