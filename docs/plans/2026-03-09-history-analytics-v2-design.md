# History Analytics V2 Design

**Date:** 2026-03-09
**Branch:** `codex/history-analytics`

## Goal

Make historical VRM imports usable in the history view, unify history and live calculations on shared canonical telemetry series, add estimated slot reconstruction when VRM data is incomplete, and upgrade the history page to real line and bar charts with source-aware cost breakdowns.

## Current Problem

- The history import can report successful VRM imports without making those rows visible in the history analytics view.
- Imported VRM rows mostly land in `vrm_*` series, while the history runtime aggregates canonical series such as `grid_import_w`, `grid_export_w`, `pv_total_w`, and `battery_power_w`.
- The current history page mostly renders compact cards and simple bar placeholders instead of proper analytics charts.
- The current financial model does not split self-consumption costs by energy source in a way that matches the desired business logic.

## Chosen Approach

Use canonical telemetry as the single source of truth for both live and historical calculations.

- Extend the VRM import pipeline so it maps historical data into the same canonical series used by live telemetry.
- Add a reconstruction layer that derives missing slot values when the VRM dataset is incomplete.
- Track whether slot values are measured, mapped from VRM, or estimated.
- Extend the history runtime to compute source-aware self-consumption costs using the same slot model for day, week, month, and year views.
- Replace the current placeholder history chart rendering with dedicated line and bar charts that expose daily and slot-based trends.

## Canonical History Data Model

The history runtime should operate on the same canonical series as live telemetry whenever possible:

- `grid_import_w`
- `grid_export_w`
- `pv_total_w`
- `battery_power_w`
- `battery_charge_w`
- `battery_discharge_w`
- `load_power_w`
- existing price series such as `price_ct_kwh`

VRM import must write to these series where direct mappings are available. Imported slot metadata must mark whether the stored value is:

- `measured`
- `mapped_from_vrm`
- `estimated`

## Slot Reconstruction

When VRM does not provide a complete slot, the import/runtime layer reconstructs the missing parts from the available energy balance.

Preferred behavior:

1. Use direct VRM values when present.
2. Use algebraic reconstruction when one or more values can be derived from the remaining terms.
3. Keep the slot in history even if not fully measured.
4. Mark reconstructed results as estimated or incomplete.

Example energy balance:

`load = pv + battery_discharge + grid_import - grid_export - battery_charge`

If enough values are known, the remaining term can be derived. If not enough values are known, the slot is still surfaced with partial estimates and an incompleteness flag instead of being dropped.

## Financial Model

Historical costs should be computed from source contributions per slot:

- grid share: `userImportPriceCtKwh`
- direct PV share: `pvCtKwh`
- battery share: `pvCtKwh + batteryBaseCtKwh + battery loss markup`

If a slot is fed by a mixture of sources, the total self-consumption cost is split proportionally by the reconstructed energy shares. Export revenue continues to use the historical market price.

This yields:

- source-specific cost breakdowns
- accurate weekly/day summaries
- consistent economics between live and historical views

## Backfill Behavior

Historical price backfill remains separate from VRM energy import, but it should work against the same canonical slot model.

- VRM backfill provides historical energy basis
- Energy Charts backfill provides missing market prices
- history aggregation uses both together

Result:

- successful VRM import immediately affects the history page
- price backfill fills only missing price slots relevant to real historical telemetry

## History UI

The history page should become a compact analytics dashboard with real charts.

### Day View

- line chart for slot-level energy and/or power trends
- line chart for market price and user import price
- financial slot series for cost, revenue, and net
- visible markers when slot values are estimated

### Week View

- bar chart per day
- revenue per day
- cost per day split into:
  - grid
  - PV
  - battery
- top KPI area with summary totals and net result

### Month and Year Views

- aggregated bars by day or month
- same financial breakdown model, but coarser grouping

## Error Handling

- Unsupported or ambiguous slot reconstructions should not silently produce exact-looking values.
- The runtime should expose unresolved and estimated counters separately.
- The UI should distinguish:
  - fully measured
  - estimated
  - incomplete

## Testing Strategy

Use TDD for each behavior change.

Required coverage:

- VRM import writes canonical telemetry series
- reconstruction derives missing slot values correctly
- source-aware cost model for grid/PV/battery mixes
- history summary reflects imported VRM data
- week chart data exposes daily revenue and source-split cost bars
- incomplete and estimated states are surfaced in API and UI

## Non-Goals

- No separate analytics database
- No silent dropping of partially known historical slots
- No fallback to keeping VRM-only raw series as the primary history source
