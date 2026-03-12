# DVhub Stop-SOC Schedule Rule Design

**Context:** The dashboard area `Boersenfenster und Regeln` currently lets each schedule row control `Grid (W)` and `Charge (A)` for a time window. Rules end only when the configured time window expires. The user needs an additional per-rule SOC threshold so discharge-oriented grid rules can stop early once the battery reaches a defined SOC.

**Scope:** Add an optional `STOP-SOC (%)` control to each dashboard schedule row and extend the runtime so `gridSetpointW` rules can end immediately when the current battery SOC reaches or falls below that threshold. Leave `chargeCurrentA` behavior unchanged.

**Goals**

- Add a third optional value `STOP-SOC (%)` to each active schedule row in the dashboard.
- Persist `STOP-SOC` only on `gridSetpointW` rules.
- End a matching grid rule immediately when `Battery SOC <= STOP-SOC`.
- Treat that early stop like a time-expired one-shot rule so it does not reactivate inside the same window.
- Keep `chargeCurrentA` rules running normally until the configured end time.
- Preserve backwards compatibility for existing saved schedule rules.

**Non-Goals**

- No global SOC stop that applies to all rules.
- No SOC-based stop behavior for `chargeCurrentA`.
- No DC-coupled MPPT control changes.
- No redesign of the wider dashboard layout beyond the additional schedule column.
- No new backend API endpoint.

**Problem Summary**

- Today a grid discharge rule only stops when its end time is reached.
- Users cannot define a battery SOC floor per discharge rule inside the schedule table.
- A rule that continues discharging after the desired SOC floor is reached can conflict with the intended operational strategy for a selected market window.
- The existing schedule model already supports one-shot deactivation after a rule has been active, so the missing piece is an additional early-stop condition for grid rules.

**Chosen Approach**

- Add an optional `STOP-SOC (%)` field with its own enable checkbox to each dashboard schedule row.
- When saving rows, attach `stopSocPct` only to the emitted `gridSetpointW` rule for that row.
- When loading rows, hydrate `stopSocPct` only from the grid rule in the grouped time slot.
- During runtime schedule evaluation, inspect the active `gridSetpointW` rule together with the current battery SOC.
- If the rule has `stopSocPct` and the current SOC is at or below that value, immediately disable that rule, persist the updated schedule, log the event, and fall back to override/default handling for grid.

**Rejected Alternatives**

- Separate row types for discharge vs. charge:
  - clearer domain model, but unnecessary UI and persistence churn for this change.
- Global stop-SOC default for all schedule rules:
  - simpler, but does not satisfy the per-rule requirement.
- Frontend-only visual stop without persisted rule state:
  - unsafe because the backend evaluator would still reactivate the rule on the next cycle.

**Target Behavior**

- Each schedule row shows `Aktiv`, `Beginn`, `Ende`, `Grid (W)`, `Charge (A)`, and `STOP-SOC (%)`.
- `STOP-SOC (%)` has its own checkbox and numeric input, matching the existing grid/charge pattern.
- A row may contain Grid, Charge, both, or neither optional value controls.
- If `STOP-SOC` is enabled and the row emits a grid rule, that rule stops permanently for the current schedule entry as soon as the measured battery SOC is less than or equal to the configured threshold.
- If the same row also contains a charge rule, that charge rule remains active until the configured end time.
- If `STOP-SOC` is not enabled, the row behaves exactly like today.

**Data Flow**

- The dashboard continues to load schedule rules from `GET /api/schedule`.
- Grouped row reconstruction reads `stopSocPct` only from `gridSetpointW` rules and renders it back into the row state.
- Saving rows still posts the rules array to `POST /api/schedule/rules`; grid rules may now include `stopSocPct`.
- Runtime reads the authoritative battery SOC from the existing telemetry snapshot already used by the dashboard.
- When an active grid rule hits its stop threshold, the backend disables that rule in `state.schedule.rules`, persists config, and publishes the updated runtime snapshot.

**Readback And Expiry Rules**

- `STOP-SOC` is evaluated only when the rule time window is currently active.
- A missing or invalid battery SOC must not stop the rule; the rule continues normally until a valid SOC is available or time expires.
- If the SOC threshold is already met when the rule window first becomes active, the rule ends immediately on that evaluation cycle.
- Early SOC stops should be visible as disabled persisted rules in the same way as time-expired one-shot rules.

**UI Notes**

- The new `STOP-SOC (%)` control should align visually with the existing schedule columns rather than creating a second editing surface.
- The field remains optional and should not introduce default values when disabled.
- Loading existing schedules without `stopSocPct` should render an empty unchecked control.
- Validation should accept only finite percentage numbers for enabled `STOP-SOC` values.

**Technical Approach**

- Update `dvhub/public/index.html` to add the new schedule table column.
- Extend `dvhub/public/app.js` row creation, collection, load, and save logic so grouped rows can round-trip `stopSocPct` on grid rules.
- Extend `dvhub/schedule-runtime.js` sanitization to preserve `stopSocPct` while still stripping legacy transient fields.
- Extend `dvhub/server.js` schedule evaluation so `gridSetpointW` rules can auto-disable on SOC threshold with a dedicated log event and persisted state update.
- Reuse the existing schedule persistence and runtime snapshot paths rather than adding a new storage model.

**Testing Impact**

- Schedule runtime tests for preserving `stopSocPct` and for early auto-disable when the SOC threshold is reached.
- Server/runtime tests for keeping `chargeCurrentA` unaffected when the paired grid rule stops on SOC.
- Dashboard tests for the new `STOP-SOC (%)` column, row collection, and grouped rule hydration.
- Regression tests ensuring existing schedules without `stopSocPct` still load and save correctly.

**Acceptance Criteria**

- The dashboard schedule table exposes an optional `STOP-SOC (%)` value per row.
- Saving a row with Grid and `STOP-SOC` persists `stopSocPct` on the grid rule only.
- During an active rule window, a grid rule with `stopSocPct` stops as soon as the measured battery SOC is less than or equal to that threshold.
- The SOC-triggered stop disables the rule immediately and keeps it from reactivating inside the same window.
- Charge rules in the same time slot continue until the configured end time.
- Existing schedules without `stopSocPct` remain valid and unchanged in behavior.
