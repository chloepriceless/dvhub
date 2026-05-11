# Aurora ID Map — current → Aurora rename matrix

**Purpose.** Per-page table mapping each JS-bound HTML ID (the binding-contract
surface) to the corresponding Aurora-designed semantic slot. Required for any
page where the designer used different ID names than the current code (PATTERNS.md §11):
**use the current ID in markup, Aurora class names for layout.** The Aurora-ID
column is informational — it documents the designer's naming intent for a
future refactor, NOT something to apply during the 09.1 port.

**Reviewer sign-off rule.** Before any page port (Plans 09.1-02 .. 09.1-07) edits
markup, the table for that page MUST be filled in AND signed off by a reviewer.
This is a procedural gate; binding-contract.mjs is the automated gate that fires
if a rename slips through.

**Pages omitted from this map** (per PATTERNS.md §11): family.html (Aurora IDs
are a strict superset of current; no rename matrix needed), integrations.html,
explorer.html, tools.html, api-docs.html (trivial or container-only overlap).

---

## index.html (138 current HTML ids · 75 distinct JS-bound ids · 39 Aurora mockup ids · 0 shared) — FILLED BY WAVE 3 (Plan 09.1-04)

**Counts (2026-05-11 re-run):**
- `dvhub/public/index.html` static `id="…"`: **138**
- `dvhub/public/app.js` + `dvhub/public/leitstand-charts.js` distinct `getElementById` ids: **75**
- `.planning/DESIGN-2026-05-10-aurora/index.html` static `id="…"`: **39**
- Shared between current HTML and JS getElementById: **72/75** (3 missing in current HTML — pre-existing regressions, restored in this wave: `log-level-filter`, `pv-forecast-chart`, `pv-forecast-skeleton`)
- Shared between current and Aurora mockup ids: **0** (designer used short keys like `epexBars`, `schedRows`, `autoPlanRows` — current uses long names like `priceChartCanvas`, `scheduleRowsDash`, `planSlotRows`)

**Port strategy (TRUE visual port, not additive):** The Aurora mockup HTML becomes the new markup
baseline (page-head + 3-col `.leit-grid` + EPEX + Schedule + SMA + Forecast sections). Every Aurora
hardcoded data point ("8.42 kW", "72%", "+€11,24" etc.) is REPLACED by a span/div with the
**Current ID** that `app.js` / `leitstand-charts.js` expects to write to. The Aurora mockup IDs in
the central powerflow + EPEX inner-bar group (`pfCenter`, `pf-center-v`, `pf-center-d`, `epexBars`,
`epexNow`, `epexOverlay`, `epexTicks`, `schedTbl`, `schedRows`, `schedCount`, `schedAdd`,
`schedReplan`, `epexAddRule`, `epexMin`/`Max`/`Avg`/`SelInfo`, `autoPlanCard`/`Meta`/`Erlös`/`Replan`,
`fcOverlay`/`Overlay2`/`Ist`/`PV`/`Load`, `smaActive`/`RulesC`) are **dropped** — they're mock data
generators driven by the inline scripts in the mockup, which we strip entirely. Live data flows
through the **Current IDs** below, written by `app.js` + `leitstand-charts.js`.

**TOPBAR-DECISION: Option A (preserve chips in `.topbar-right`).** The 5 integration badges
(`badge-mqtt`, `badge-tesla`, `badge-ha`, `badge-loxone`, `badge-ml`) + `connStatus` + `nowTime`
live in `.topbar-right` styled with the Aurora `.chip` class. `leitstand-charts.js` `setBadgeState()`
(L467-479) toggles `[hidden]`; Aurora's `.chip` styling already handles display.

**PF-MOUNT contract:** The Aurora mockup's central `.pf-shell` block contains a static SVG
animation + mock node readouts (`pfCenter`/`pf-center-v`/`pf-center-d`/`pf-node`s). All of that is
stripped. The slot is replaced with the single live mount:

```html
<section class="card flush pf-shell aurora-edge">
  <div class="dvhub-powerflow" id="leitstandPowerflow"></div>
</section>
```

`dvhub-powerflow.js` mounts via `window.DVhubPowerflow.mount(mountEl)` (called from `app.js#L136`)
and paints its own canvas-driven particle animation using live `state.victron` data.

### Left rail · PV / Battery / DV-Status / VPN

| Aurora slot                              | Current ID                | JS module · line          | Decision  |
|------------------------------------------|---------------------------|---------------------------|-----------|
| PV-Gesamt big number                     | pvTotal                   | app.js · L? (setText)     | preserve  |
| PV-Gesamt DC-PV row                      | pvP                       | app.js · L? (setText)     | preserve  |
| PV-Gesamt AC-PV row                      | pvAc                      | app.js · L? (setText)     | preserve  |
| PV-Gesamt DC-Einspeisung row             | dvDcPv                    | app.js · L? (setText)     | preserve  |
| PV-Gesamt AC-PV blockiert row            | dvAcPv                    | app.js · L? (setText)     | preserve  |
| Batterie SOC big number                  | soc                       | app.js · L? (setText)     | preserve  |
| Batterie SOC bar fill                    | socBar                    | app.js · L130             | preserve  |
| Batterie Akku-Leistung row               | batP                      | app.js · L? (setText)     | preserve  |
| Batterie Grid-Setpoint row               | gridSetpoint              | app.js · L? (setText)     | preserve  |
| Batterie Min-SOC row (clickable)         | minSocRow                 | app.js · L1274,2342,2343  | preserve  |
| Batterie Min-SOC value                   | minSoc                    | app.js · L1305            | preserve  |
| Batterie Min-SOC editor panel            | minSocEditor              | app.js · L1275            | preserve  |
| Batterie Min-SOC editor value display    | minSocEditorValue         | app.js · L1256            | preserve  |
| Batterie Min-SOC slider                  | minSocSlider              | app.js · L1262,1332,2344,2383 | preserve |
| Batterie Min-SOC submit button           | minSocSubmitBtn           | app.js · L2368            | preserve  |
| DV-Status big                            | dvStatus                  | app.js · L? (setText)     | preserve  |
| DV Control Value row                     | dvValue                   | app.js · L? (setText)     | preserve  |
| DV Lease-Bis row                         | offUntil                  | app.js · L? (setText)     | preserve  |
| DV Letzte Modbus-Abfrage row             | kaModbus                  | app.js · L? (setText)     | preserve  |
| DV VPN-Status row container              | dvVpnRow                  | app.js · L1371            | preserve  |
| DV VPN-Status row value                  | dvVpnStatus               | app.js · L? (setText)     | preserve  |
| VPN card host                            | vpnCard                   | app.js · L2293            | preserve  |
| VPN status big                           | vpnStatus                 | app.js · L? (setText)     | preserve  |
| VPN tunnel-IP row                        | vpnTunIp                  | app.js · L? (setText)     | preserve  |
| VPN uptime row                           | vpnUptime                 | app.js · L? (setText)     | preserve  |
| VPN reconnects row                       | vpnReconnects             | app.js · L? (setText)     | preserve  |
| VPN cert-warn row                        | vpnCertWarn               | app.js · L2318            | preserve  |
| VPN cert-days strong                     | vpnCertDays               | app.js · L? (setText)     | preserve  |
| VPN reconnect button                     | vpnReconnectBtn           | app.js · L2331            | preserve  |

### Right rail · Markt / Kosten / Automatik / Steuerung

| Aurora slot                              | Current ID                | JS module · line          | Decision  |
|------------------------------------------|---------------------------|---------------------------|-----------|
| Markt aktueller Preis big                | priceNow                  | app.js · L? (setText)     | preserve  |
| Markt nächster Slot row                  | priceNext                 | app.js · L? (setText)     | preserve  |
| Markt heute-negativ row                  | negLater                  | app.js · L? (setText)     | preserve  |
| Markt morgen-negativ row                 | negTomorrow               | app.js · L? (setText)     | preserve  |
| Markt heute min/max row                  | todayMinMax               | app.js · L? (setText)     | preserve  |
| Markt morgen min/max row                 | tomorrowMinMax            | app.js · L? (setText)     | preserve  |
| Markt Negativpreis-Schutz row            | negPriceProtection        | app.js · L? (setText)     | preserve  |
| Kosten Import row                        | costImport                | app.js · L? (setText)     | preserve  |
| Kosten Export row                        | costExport                | app.js · L? (setText)     | preserve  |
| Kosten Cost row                          | costCost                  | app.js · L? (setText)     | preserve  |
| Kosten Revenue row                       | costRevenue               | app.js · L? (setText)     | preserve  |
| Kosten Netto row                         | costNet                   | app.js · L? (setText)     | preserve  |
| Automatik summary title                  | automationSummaryTitle    | app.js · L? (setText)     | preserve  |
| Automatik status bar row container       | automationStatusBar       | app.js · L? (setText)     | preserve  |
| Automatik status outcome                 | automationOutcome         | app.js · L2206            | preserve  |
| Automatik rule count                     | automationRuleCount       | app.js · L2207            | preserve  |
| Automatik available energy               | automationAvailableEnergy | app.js · L2208            | preserve  |
| Steuerung aktiver grid setpoint          | activeGridSetpoint        | app.js · L? (setText)     | preserve  |
| Steuerung aktiver charge current         | activeChargeCurrent       | app.js · L? (setText)     | preserve  |
| Steuerung aktiver min-soc                | activeMinSoc              | app.js · L? (setText)     | preserve  |
| Steuerung aktiver DC-feed                | activeDcFeed              | app.js · L? (setText)     | preserve  |
| Steuerung letzter write                  | lastControlWrite          | app.js · L? (setText)     | preserve  |
| Steuerung manual-grid input              | manualGridValue           | app.js · L1638            | preserve  |
| Steuerung manual-grid button             | manualGridBtn             | app.js · L2340            | preserve  |
| Steuerung manual-charge input            | manualChargeValue         | app.js · L1652            | preserve  |
| Steuerung manual-charge button           | manualChargeBtn           | app.js · L2341            | preserve  |
| Steuerung default-grid input             | defaultGridSetpointInput  | app.js · L1968,1998,2351  | preserve  |
| Steuerung default-charge input           | defaultChargeCurrentInput | app.js · L1973,2000,2353  | preserve  |
| Steuerung default-DC input               | defaultFeedExcessDcPvInput| app.js · L1978,2002       | preserve  |
| Steuerung save-defaults button           | saveDefaultsBtn           | app.js · L2349            | preserve  |

### EPEX chart + schedule editor + automation panel

| Aurora slot                              | Current ID                | JS module · line          | Decision  |
|------------------------------------------|---------------------------|---------------------------|-----------|
| EPEX chart canvas (Chart.js)             | priceChartCanvas          | app.js · L562             | preserve  |
| EPEX chart container                     | priceChartContainer       | app.js · L563,1498        | preserve  |
| EPEX chart tooltip                       | tooltip                   | app.js · L564,915,1154,2034 | preserve|
| EPEX refresh button                      | refreshEpex               | app.js · L2336            | preserve  |
| EPEX schedule callout                    | chartScheduleCallout      | app.js · L447             | preserve  |
| EPEX selection summary                   | chartSelectionSummary     | app.js · L448             | preserve  |
| EPEX selection detail                    | chartSelectionDetail      | app.js · L449             | preserve  |
| EPEX create-selection-schedule button    | createSelectionScheduleBtn| app.js · L450,2369        | preserve  |
| EPEX comparison summary                  | chartComparisonSummary    | app.js · L511             | preserve  |
| EPEX comparison detail                   | chartComparisonDetail     | app.js · L512             | preserve  |
| EPEX chart meta footer                   | chartMeta                 | app.js · L? (setText)     | preserve  |
| Schedule sched-col-grid checkbox         | schedColGrid              | app.js · L? (UI flag)     | preserve  |
| Schedule sched-col-charge checkbox       | schedColCharge            | app.js · L? (UI flag)     | preserve  |
| Schedule auto-plan summary               | automationPlanSummary     | app.js · L2238            | preserve  |
| Schedule plan-computed-at                | planComputedAt            | app.js · L2251            | preserve  |
| Schedule plan-energy-budget              | planEnergyBudget          | app.js · L2252            | preserve  |
| Schedule plan-estimated-revenue          | planEstimatedRevenue      | app.js · L2253            | preserve  |
| Schedule plan slot rows tbody            | planSlotRows              | app.js · L2279            | preserve  |
| Schedule replan-automation button        | replanAutomationBtn       | app.js · L2182,2380       | preserve  |
| Schedule rows tbody                      | scheduleRowsDash          | app.js · L1824,1846,1898,1903 | preserve |
| Schedule add-row button                  | addScheduleRowBtn         | app.js · L2339            | preserve  |
| Schedule load button                     | loadScheduleBtn           | app.js · L2337            | preserve  |
| Schedule save button                     | saveScheduleBtn           | app.js · L2338            | preserve  |
| Schedule control message                 | controlMsg                | app.js · L90              | preserve  |
| SMA panel section                        | automationPanel           | app.js · L? (CSS host)    | preserve  |
| SMA enabled checkbox                     | automationEnabled         | app.js · L2210            | preserve  |
| SMA status title                         | automationStatusTitle     | app.js · L2205            | preserve  |
| SMA status bar panel                     | automationStatusBarPanel  | app.js · L? (setText host)| preserve  |
| SMA outcome panel                        | automationOutcomePanel    | app.js · L? (setText)     | preserve  |
| SMA rule count panel                     | automationRuleCountPanel  | app.js · L? (setText)     | preserve  |
| SMA available energy panel               | automationAvailableEnergyPanel | app.js · L? (setText)| preserve  |
| SMA config grid                          | automationConfigGrid      | app.js · L? (CSS host)    | preserve  |
| SMA search start                         | automationSearchStart     | app.js · L? (input read)  | preserve  |
| SMA search end                           | automationSearchEnd       | app.js · L? (input read)  | preserve  |
| SMA battery capacity                     | automationBatteryCapacity | app.js · L? (input read)  | preserve  |
| SMA inverter efficiency                  | automationInverterEfficiency | app.js · L? (input read)| preserve |
| SMA max discharge W                      | automationMaxDischargeW   | app.js · L? (input read)  | preserve  |
| **SMA per-slot stopSocPct floor (b3c4901 hotfix)** | **automationMinSocPct** | app.js · L? (input read) | **preserve — battery safety knob** |
| **SMA stages rows container**            | **automationStagesContainer** | **app.js · L2074**    | **preserve — JS-populated host** |
| SMA add-stage button                     | addAutomationStageBtn     | app.js · L2378            | preserve  |
| SMA save button                          | saveAutomationConfigBtn   | app.js · L2379            | preserve  |

### Forecast / Optimizer / Savings (Phase 04 INTG-01)

| Aurora slot                              | Current ID                | JS module · line          | Decision  |
|------------------------------------------|---------------------------|---------------------------|-----------|
| Forecast overlay toggle                  | overlay-toggle            | leitstand-charts.js · L373| preserve  |
| Forecast summary row                     | forecast-summary-row      | -                         | preserve  |
| PV daily card                            | pv-daily-card             | -                         | preserve  |
| PV daily kwh                             | pv-daily-kwh              | leitstand-charts.js · L1044 | preserve |
| PV daily detail                          | pv-daily-detail           | leitstand-charts.js · L1045 | preserve |
| Load daily card                          | load-daily-card           | -                         | preserve  |
| Load daily kwh                           | load-daily-kwh            | leitstand-charts.js · L1046 | preserve |
| Load daily detail                        | load-daily-detail         | leitstand-charts.js · L1047 | preserve |
| Surplus daily card                       | surplus-daily-card        | -                         | preserve  |
| Surplus daily kwh                        | surplus-daily-kwh         | leitstand-charts.js · L1048 | preserve |
| Surplus daily detail                     | surplus-daily-detail      | leitstand-charts.js · L1049 | preserve |
| **PV forecast skeleton (restore)**       | **pv-forecast-skeleton**  | leitstand-charts.js · L173 | restore — pre-existing regression |
| **PV forecast canvas (restore)**         | **pv-forecast-chart**     | leitstand-charts.js · L172 | restore — pre-existing regression |
| Forecast comparison card                 | forecastComparisonCard    | leitstand-charts.js · L638 | preserve |
| Forecast comparison skeleton             | forecastCompSkeleton      | leitstand-charts.js · L639 | preserve |
| Forecast comparison canvas               | forecastComparisonChart   | leitstand-charts.js · L514 | preserve |
| Forecast comparison subtitle             | forecastCompSubtitle      | -                         | preserve  |
| Forecast comparison legend host          | forecastCompLegend        | leitstand-charts.js · L597 | preserve |
| Forecast day summary                     | forecastDaySummary        | leitstand-charts.js · L732 | preserve |
| Optimizer plan card                      | optimizerPlanCard         | leitstand-charts.js · L882 | preserve |
| Optimizer plan canvas                    | optimizerPlanChart        | leitstand-charts.js · L883 | preserve |
| Optimizer plan skeleton                  | optimizerPlanSkeleton     | leitstand-charts.js · L884 | preserve |
| Optimizer plan subtitle                  | optimizerPlanSubtitle     | leitstand-charts.js · L885 | preserve |
| Optimizer plan legend                    | optimizerPlanLegend       | leitstand-charts.js · L1016 | preserve |
| Gantt chart canvas                       | gantt-chart               | leitstand-charts.js · L266 | preserve |
| Gantt skeleton                           | gantt-skeleton            | leitstand-charts.js · L267 | preserve |
| Savings total                            | savings-total             | leitstand-charts.js · L436 | preserve |
| Savings breakdown                        | savings-breakdown         | leitstand-charts.js · L437 | preserve |

### Topbar / log / misc

| Aurora slot                              | Current ID                | JS module · line          | Decision  |
|------------------------------------------|---------------------------|---------------------------|-----------|
| Topbar burger checkbox                   | menuToggle                | -                         | drop — Aurora topbar uses overflow-x scroll |
| Topbar conn-status dot                   | connStatus                | app.js · L? (setText)     | preserve (Option A chip) |
| Topbar clock                             | nowTime                   | app.js · L? (setText)     | preserve (Option A chip) |
| Topbar MQTT chip                         | badge-mqtt                | leitstand-charts.js · L487 | preserve |
| Topbar Tesla chip                        | badge-tesla               | leitstand-charts.js · L488 | preserve |
| Topbar HA chip                           | badge-ha                  | leitstand-charts.js · L489 | preserve |
| Topbar Loxone chip                       | badge-loxone              | leitstand-charts.js · L490 | preserve |
| Topbar ML chip                           | badge-ml                  | leitstand-charts.js · L806 | preserve |
| Log box                                  | logBox                    | app.js · L1511,1551,1561,1567 | preserve |
| **Log level filter select (restore)**    | **log-level-filter**      | app.js · L1513            | restore — lazy-created if absent, but pre-existing static markup was dropped in d039907; re-add explicit `<select>` placeholder |

### Aurora-only IDs (dropped from port)

| Aurora ID         | Reason for drop                                                            |
|-------------------|----------------------------------------------------------------------------|
| `app-shell-top`/`-foot` | Aurora's shell-mount is via `DVhub_mountShell()` — we hand-roll the topbar to match Wave 1/2 pattern (see PATTERNS.md §7 gotcha 1 — duplicate theme writers) |
| `pfCenter`, `pf-center-v`, `pf-center-d` | Mock-powerflow text — would display "8.42 kW" / "+€11,24" forever (RESEARCH §4 Pitfall 3). Live `dvhub-powerflow.js` paints its own animation |
| `epexBars`, `epexNow`, `epexOverlay`, `epexTicks` | SVG mock chart group + ticks — `priceChartCanvas` is a Chart.js canvas; the SVG bars are mock-data driven and not part of the live data flow |
| `epexMin`, `epexMax`, `epexAvg`, `epexSelInfo`, `epexAddRule` | Mock summary widgets; `chartSelectionSummary` / `chartSelectionDetail` / `createSelectionScheduleBtn` are the live equivalents |
| `autoPlanCard`, `autoPlanMeta`, `autoPlanErlös`, `autoPlanRows`, `autoPlanReplan` | Mock auto-plan table; `automationPlanSummary` / `planSlotRows` / `replanAutomationBtn` are the live IDs |
| `schedCount`, `schedTbl`, `schedRows`, `schedAdd`, `schedReplan` | Mock schedule table; `scheduleRowsDash` / `addScheduleRowBtn` / `loadScheduleBtn` / `saveScheduleBtn` are live |
| `smaActive`, `smaRulesC`             | Mock SMA toggle + count; `automationEnabled` + `automationRuleCount` are live |
| `fcOverlay`, `fcOverlay2`, `fcIst`, `fcPV`, `fcLoad` | Mock forecast SVG paths; `forecastComparisonChart` (Chart.js canvas) is the live forecast |

---

## history.html (86 current HTML ids · 81 distinct JS-bound ids · 69 Aurora mockup ids · 0 shared) — FILLED BY WAVE 2 (Plan 09.1-03)

**Counts (2026-05-11):**
- `dvhub/public/history.html` static `id="…"`: **86**
- `dvhub/public/history.js` distinct bound ids (via `byId`/`getElementById`/`setText`/`setHtml`/`setHidden` + 4 chart mount strings): **81**
- `.planning/DESIGN-2026-05-10-aurora/history.html` static `id="…"`: **69**
- Shared ids between current HTML and current JS: **81/81** (every JS-bound id has markup — `binding-contract --page history` exits 0 at baseline)
- Shared ids between current and Aurora mockup: **0** (designer used short keys; current uses long `historyKpi…` prefix)

**Rule applied per PATTERNS.md §11:** the **Current ID** column is what stays in the markup
(preserves binding contract). The **Aurora ID** column is informational — documents the
designer's semantic-slot naming intent. The **Aurora class** column is the Aurora structural class
the slot lives inside (`.calc-card`, `.calc-row-line`, `.card`, etc.) which the port applies to
the existing markup element.

### KPI / breakdown cards (6 calc-card panels)

| Semantic slot (Aurora)             | Aurora ID            | Current ID                       | JS module · line     | Aurora class wrapper             |
|------------------------------------|----------------------|----------------------------------|----------------------|----------------------------------|
| Energiekosten — total              | kpiTotalCost         | historyKpiTotalCost              | history.js · L148    | `.calc-card[data-accent="cost"]` |
| Energiekosten — Strombezug         | kpiCost              | historyKpiCost                   | history.js · L149    | `.calc-row-line strong.acc`      |
| Energiekosten — PV-Gestehung       | kpiPvCost            | historyKpiAvoidedPvCost          | history.js · L150    | `.calc-row-line strong.acc`      |
| Energiekosten — Akku-Verschleiss   | kpiBatCost           | historyKpiAvoidedBatteryCost     | history.js · L151    | `.calc-row-line strong.acc`      |
| Energieeinnahmen — total           | kpiTotalRevenue      | historyKpiTotalRevenue           | history.js · L154    | `.calc-card[data-accent="revenue"]` |
| Energieeinnahmen — Einspeisung     | kpiRevenueSpot       | historyKpiRevenue                | history.js · L155    | `.calc-row-line strong.acc`      |
| Netto Cashflow — total             | kpiNet               | historyKpiNet                    | history.js · L158,216| `.calc-card[data-accent="net"]`  |
| Netto Cashflow — Einspeisung in    | kpiCashIn            | historyKpiCashIn                 | history.js · L159    | `.calc-row-line strong.ok`       |
| Netto Cashflow — Strombezug out    | kpiCashOut           | historyKpiCashOut                | history.js · L160    | `.calc-row-line strong.warn`     |
| Vermiedene Kosten — total          | kpiAvoided           | historyKpiAvoided                | history.js · L170,2021 | `.calc-card[data-accent="avoided"]` |
| Vermiedene Kosten — label          | avoidedLabel         | historyAvoidedLabel              | history.js · L2009   | `.calc-kicker`                   |
| Vermiedene Kosten — default block  | avoidedDefault       | historyAvoidedDefault            | history.js · L2007   | `.calc-rows`                     |
| Vermiedene Kosten — PV gross       | (none)               | historyKpiAvoidedPvGross         | history.js · L171    | `.calc-row-line strong.acc`      |
| Vermiedene Kosten — Bat gross      | (none)               | historyKpiAvoidedBatteryGross    | history.js · L172    | `.calc-row-line strong.acc`      |
| Vermiedene Kosten — market block   | avoidedMarket        | historyAvoidedMarket             | history.js · L2008   | `.calc-rows[hidden]`             |
| Vermiedene Kosten — PV market      | (none)               | historyKpiAvoidedPvMarket        | history.js · L174    | `.calc-row-line strong.acc`      |
| Vermiedene Kosten — Bat market     | (none)               | historyKpiAvoidedBatMarket       | history.js · L175    | `.calc-row-line strong.acc`      |
| Vermiedene Kosten — Opp.kosten     | (none)               | historyKpiOppCost                | history.js · L176    | `.calc-row-line strong.warn`     |
| Vermiedene Kosten — Marktwert toggle | marketToggle       | historyMarketToggle              | history.js · L2002   | `.calc-toggle` (Aurora) / `.btn.ghost.sm` |
| Energiebilanz — PV-Erzeugung       | kpiPv                | historyKpiPv                     | history.js · L179    | `.calc-card[data-accent="energy"]` `.calc-row-line strong.acc` |
| Energiebilanz — Eigenverbrauch     | (none)               | historyKpiSelfCons               | history.js · L180    | `.calc-row-line strong`          |
| Energiebilanz — Bezug              | kpiImport            | historyKpiImport                 | history.js · L181    | `.calc-row-line strong`          |
| Energiebilanz — Einspeisung        | kpiExport            | historyKpiExport                 | history.js · L182    | `.calc-row-line strong`          |
| Energiebilanz — VBH                | (none)               | historyKpiVbh                    | history.js · L183    | `.calc-row-line strong`          |
| Energiebilanz — Akku-Zyklen        | (none)               | historyKpiCycles                 | history.js · L184    | `.calc-row-line strong`          |
| Energiebilanz — Zyklen label       | (none)               | historyKpiCyclesLabel            | history.js · L185    | `.calc-row-line span`            |
| Gesamtbilanz — card                | (none)               | historyKpiBilanzCard             | history.js · L205,2025 | `.calc-card[data-accent="bilanz"]` |
| Gesamtbilanz — total (gross)       | kpiGross             | historyKpiGrossReturn            | history.js · L198,209,2023,2029 | `.calc-total`           |
| Gesamtbilanz — Vermiedene          | (none)               | historyKpiBilanzAvoided          | history.js · L199    | `.calc-row-line strong`          |
| Gesamtbilanz — Netto Cashflow      | (none)               | historyKpiBilanzNet              | history.js · L200    | `.calc-row-line strong`          |
| Gesamtbilanz — PV-Gestehung        | (none)               | historyKpiBilanzPvCost           | history.js · L201    | `.calc-row-line strong.warn`     |
| Gesamtbilanz — Akku-Verschleiss    | (none)               | historyKpiBilanzBatCost          | history.js · L202    | `.calc-row-line strong.warn`     |

### Direktvermarktung (DV) card

| Semantic slot (Aurora)             | Aurora ID            | Current ID                       | JS module · line     | Aurora class wrapper             |
|------------------------------------|----------------------|----------------------------------|----------------------|----------------------------------|
| DV card (toggle visibility)        | (none — Aurora ships expanded) | historyDvCard          | history.js · L223    | `.card` (toggle via `hidden`)    |
| DV — Tats.Einspeise Erlös          | (none)               | historyKpiDvRevenue              | history.js · L228    | `.calc-total`                    |
| DV — eff. ct/kWh                   | (none)               | historyKpiDvRevenueRate          | history.js · L229    | `.calc-row-line strong`          |
| DV — Marktwert label               | (none)               | historyKpiDvMarketValueLabel     | history.js · L233    | `.calc-row-line span`            |
| DV — Marktwert                     | (none)               | historyKpiDvMarketValue          | history.js · L234    | `.calc-row-line strong`          |
| DV — Anzulegender Wert             | (none)               | historyKpiDvApplicableValue      | history.js · L235    | `.calc-row-line strong`          |
| DV — Hyp. Volleinspeisung          | (none)               | historyKpiHypFullFeedIn          | history.js · L237    | `.calc-row-line strong`          |
| DV — Hyp. Überschuss-Einspeisung   | (none)               | historyKpiHypSurplusFeedIn       | history.js · L238    | `.calc-row-line strong`          |
| DV — Mehrerlös                     | (none)               | historyKpiDvExcess               | history.js · L241    | `.calc-row-line strong.ok`       |
| DV — Kosten                        | (none)               | historyKpiDvCost                 | history.js · L249    | `.calc-row-line strong.warn`     |
| DV — Netto-Vorteil                 | (none)               | historyKpiDvNetAdvantage         | history.js · L252    | `.calc-row-line.sep strong`      |

### Marktprämie card

| Semantic slot (Aurora)             | Aurora ID            | Current ID                       | JS module · line     | Aurora class wrapper             |
|------------------------------------|----------------------|----------------------------------|----------------------|----------------------------------|
| Premium fields card                | (none)               | historyPremiumFields             | history.js · L275    | `.card` (toggle via `hidden`)    |
| Premium hint                       | (none)               | historyPremiumHint               | history.js · L276,277,314 | `.card-sub`                 |
| Premium scope label                | (none)               | historyPremiumScopeLabel         | history.js · L278    | `.card-kicker`                   |
| Premium market value label         | (none)               | historyPremiumMarketValueLabel   | history.js · L279    | `.calc-row-line span`            |
| Premium rate label                 | (none)               | historyPremiumRateLabel          | history.js · L280    | `.calc-row-line span`            |
| Premium — Annual MW                | (none)               | historyKpiAnnualMarketValue      | history.js · L283    | `.calc-row-line strong`          |
| Premium — Eligible export          | (none)               | historyKpiPremiumEligibleExport  | history.js · L289    | `.calc-row-line strong`          |
| Premium — Market premium           | (none)               | historyKpiMarketPremium          | history.js · L295    | `.calc-row-line strong`          |
| Premium — Market premium rate      | (none)               | historyKpiMarketPremiumRate      | history.js · L301    | `.calc-row-line strong`          |

### Toolbar + period nav (header)

| Semantic slot (Aurora)             | Aurora ID            | Current ID                       | JS module · line     | Aurora class wrapper             |
|------------------------------------|----------------------|----------------------------------|----------------------|----------------------------------|
| Meta line ("30 Tage · …")          | periodMeta           | historyMeta                      | history.js · L1851   | `.meta`                          |
| Prev period button                 | prevBtn              | historyPrevBtn                   | history.js · L1986   | `.iconbtn` (Aurora) / `.btn.ghost.sm` |
| Next period button                 | nextBtn              | historyNextBtn                   | history.js · L1987   | `.iconbtn` (Aurora) / `.btn.ghost.sm` |
| View segmented (day/week/…)        | viewSeg              | historyView                      | history.js · L1893+  | `.segmented` (Aurora) / `<select>` |
| Date input                         | (none — Aurora uses date in toolbar) | historyDate      | history.js · L1894+  | toolbar input                    |
| Backfill prices button             | btnBackfill          | historyBackfillBtn               | history.js · L130,1984 | `.btn.sm.primary`              |
| Export CSV button                  | (none)               | historyExportCsvBtn              | history.js · L1955,1985 | `.btn.sm.ghost`               |

### Status banner

| Semantic slot (Aurora)             | Aurora ID            | Current ID                       | JS module · line     | Aurora class wrapper             |
|------------------------------------|----------------------|----------------------------------|----------------------|----------------------------------|
| Status banner container            | (Aurora uses `.hist-banner`) | historyBanner            | history.js · L65     | `.hist-banner` / legacy `.status-banner` |
| Banner text                        | (Aurora: `.txt` span) | historyBannerText               | history.js · L68     | `.hist-banner .txt`              |
| Banner info toggle button          | (none)               | historyStatusInfoToggle          | history.js · L72     | `.btn.sm.ghost`                  |
| Banner info expandable             | (none)               | historyStatusInfo                | history.js · L73     | `.history-status-info`           |

### Chart panels (Chart.js mounts — KEEP IDS, history.js does `mount.innerHTML = '<canvas id="…Canvas">'`)

| Semantic slot (Aurora)             | Aurora ID            | Current ID                       | JS module · line     | Aurora class wrapper             |
|------------------------------------|----------------------|----------------------------------|----------------------|----------------------------------|
| Chart grid section                 | (none)               | historyChartGrid                 | history.js · L1730   | `.grid` / `.history-chart-grid`  |
| Financial chart panel              | (none)               | historyFinancialPanel            | history.js · L1731   | `.card`                          |
| Financial chart mount (Chart.js)   | netSvg / netBars     | historyFinancialChart            | history.js · L1593,1620,1622 | `.history-chart-shell`   |
| Solar summary block                | (none)               | historySolarSummary              | history.js · L1615,1640 | (free)                        |
| Aggregate mode container           | chartModeFin         | historyAggregateMode             | history.js · L1735   | `.chart-mode`                    |
| Aggregate Overview button          | (chart-mode buttons) | historyAggregateOverviewBtn      | history.js · L1736   | `.chart-mode button`             |
| Aggregate Table button             | (chart-mode buttons) | historyAggregateTableBtn         | history.js · L1737   | `.chart-mode button`             |
| Energy panel                       | (none)               | historyEnergyPanel               | history.js · L1732   | `.card`                          |
| Energy chart mount                 | energySvg            | historyEnergyChart               | history.js · L1603,1605,1607,1625,1629,1631 | `.history-chart-shell` |
| Energy mode container              | chartModeEnergy      | historyEnergyMode                | history.js · L1765   | `.chart-mode`                    |
| Energy Flows button                | (chart-mode buttons) | historyEnergyFlowsBtn            | history.js · L1766   | `.chart-mode button`             |
| Energy Lines button                | (chart-mode buttons) | historyEnergyLinesBtn            | history.js · L1767   | `.chart-mode button`             |
| Energy Sankey button               | (chart-mode buttons) | historyEnergySankeyBtn           | history.js · L1768   | `.chart-mode button`             |
| Price panel                        | (none)               | historyPricePanel                | history.js · L1733   | `.card`                          |
| Price chart mount                  | (none)               | historyPriceChart                | history.js · L1609,1633 | `.history-chart-shell`        |
| Price list block                   | (none)               | historyPriceList                 | history.js · L1613,1634 | (free)                        |
| Aggregate price hint               | (none)               | historyAggregatePriceHint        | history.js · L1614   | `.card-sub`                      |
| Month-daily panel                  | (none)               | historyMonthDailyPanel           | history.js · L1734   | `.card`                          |
| Month-daily chart mount            | monthDailySvg / monthBars | historyMonthDailyChart      | history.js · L1586   | `.history-chart-shell`           |

**Chart-canvas note:** All four chart mount IDs (`historyFinancialChart`, `historyEnergyChart`,
`historyMonthDailyChart`, `historyPriceChart`) host the `<canvas>` element via `mount.innerHTML`
at history.js L870, L1180, L1320, L1401, L1531 — the canvases are dynamically created with id
= `mountId + 'Canvas'` (e.g. `historyEnergyChartCanvas`). The mount-div IDs must be preserved;
the canvas IDs are pure JS strings, not in the static HTML.

### Details + ledger

| Semantic slot (Aurora)             | Aurora ID            | Current ID                       | JS module · line     | Aurora class wrapper             |
|------------------------------------|----------------------|----------------------------------|----------------------|----------------------------------|
| Details toggle button              | detailToggleBtn      | historyDetailsToggle             | history.js · L1805   | `.btn.sm.ghost`                  |
| Details content (collapsible)      | detailContent        | historyDetailsContent            | history.js · L1806   | `.detail-content`                |
| Detail rows mount                  | detailBody           | historyRows                      | history.js · L1644   | `.history-rows`                  |

---

### Open questions / Aurora drops (informational)

**Current IDs with NO Aurora-mockup equivalent (39 of 81):**
The bulk of `historyKpi*` IDs above (`historyKpiAvoidedBatMarket`, `historyKpiBilanzAvoided`,
`historyKpiDvCost`, `historyKpiOppCost`, etc.) have no Aurora-mockup counterpart because the
designer drew **fewer** breakdown rows per card. These IDs stay in markup; their containing
element gets the Aurora `.calc-row-line` class.

**Aurora-new IDs we are NOT adopting in this port:**
Aurora introduces ~40 mockup-only IDs for sections that do not exist in the production app:
`autarkCal`, `autarkLegend`, `autarkSingle`, `ringSvg`, `sankeySvg`, `vDuration`, `vPHeat`,
`vSpag`, `vCycles`, `vTop10`, `vCalYear`, `vStack`, `vTree`, `vBullets`, `vScatter`, `ledgerBody`,
`hm`, `hmMeta`, `g-pv`, `g-bat`, `g-grid`, `g-net`, `g-pv2`, `netCumLine`, `monthRevLine`,
`histPage`, `chartFootMeta`, `chartModeFin`, `chartModeEnergy`, `chartSub`, `hmSub`, `autarkSub`,
`autarkMode`, `detailToggle`, etc. The current dvhub history page does not implement those
visualisations (autarky calendar, ring chart, sankey diagram, ledger table, twelve "viz" cards) —
they are designer-future-work, NOT in v1.0 scope per RESEARCH §2. Port skips them entirely.

**Topbar choice for history.html (carried decision from Wave 1):**
**HAND-ROLL** — same as Wave 1 family port. Reasons: (a) family.html uses no topbar (kiosk) so
there is no existing precedent for `DVhub_mountShell`; (b) the current `<header class="compact-topbar">`
markup is already CSP-clean and works across all 8 non-family pages without JS-time mount; (c)
adopting `DVhub_mountShell` repo-wide would be a separate refactor that risks breaking the active
`a.is-active` link highlight, the burger toggle, and 6 page tests. Decision: keep the existing
`<header class="compact-topbar">` shape, swap `<link rel="stylesheet" href="/styles.css">` →
`<link rel="stylesheet" href="/dvhub-app.css">` + add `<link rel="stylesheet" href="/history.css">`
+ add `<script src="/theme.js">` + add a `.theme-toggle` button into `.topbar-right`. Aurora
`.topbar` selectors in `dvhub-app.css` already match `.compact-topbar` markup closely enough that
the existing structure paints in Aurora dark/light theme. Page-specific tweaks live in
`history.css` (which also carries every `history-*` utility class previously in `styles.css`).

---

## settings.html — TO BE FILLED BY WAVE 4 PRE-WORK

Most settings IDs are JS-generated by `renderConnectionGrid()` / `createConfigGroup()` etc.
in settings.js (22 `document.createElement` calls). This table covers static container
anchors only (tab panels, the floating save-bar, the VPN upload panel mount).

| Semantic slot (Aurora) | Aurora ID | Current ID         | JS module · line   | Notes                                                 |
|------------------------|-----------|--------------------|--------------------|-------------------------------------------------------|
| Floating save-bar text | (none)    | saveBarText        | settings.js · L1660| Preserve; Aurora wireframe lacks this affordance      |
|                        |           |                    |                    |                                                       |

---

## setup.html — TO BE FILLED BY WAVE 4 PRE-WORK

| Semantic slot (Aurora) | Aurora ID | Current ID | JS module · line | Notes |
|------------------------|-----------|------------|------------------|-------|
| Wizard step container  | (TBD)     | (TBD)      | setup.js · L?    |       |
|                        |           |            |                  |       |

---

Family, integrations, explorer, tools, api-docs do NOT need an ID-map (per PATTERNS.md §11).
