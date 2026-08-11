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

## settings.html (94 static HTML ids · 62 distinct JS-bound ids · 6 Aurora mockup ids · 0 shared) — FILLED BY WAVE 4 (Plan 09.1-05)

**Counts (2026-05-12 pre-port):**
- `dvhub/public/settings.html` static `id="…"`: **94**
- `dvhub/public/settings.js` distinct `getElementById` ids (excluding `createElement` lines): **62**
- `.planning/DESIGN-2026-05-10-aurora/settings.html` static `id="…"`: **6** (`anlage`, `optimizer`, `tariff`, `dv`, `notify`, `users` — section anchors only; the entire form field surface is wireframed but unlabeled)
- Shared between current HTML and JS getElementById: 43 static + 19 dynamic (JS-injected via `innerHTML` templates or `el.id =` assignments inside `renderVpnUploadPanel()`, location-picker overlay, forecast-tier badge, EPEX backlog info section, `reloadConfigBtn` in tools panel) — all 62 resolve once the page is loaded and settings.js has run init.
- Shared between current and Aurora mockup ids: **0** (Aurora wireframe has zero binding overlap — the visual reskin must preserve the current ID surface)

**Port strategy (Wave 4 — additive restyle, NOT markup replacement).** Current `settings.html` already
uses Aurora-style class names (`settings-aurora`, `sa-*`, `config-*`, `settings-tab*`, `data-tab=`)
that were introduced in a prior Phase 8 pass. The Wave-4 work is the link/script-tag migration:
- Drop `/styles.css`, add `/dvhub-app.css` + new `/settings.css` (page-specific block ported from
  the relevant `styles.css` sections so the page paints without `styles.css`).
- Add `<script src="/theme.js"></script>` early in `<head>` (block flash-of-wrong-theme).
- Replace the legacy `<header class="compact-topbar">` topbar with the Wave-3 Aurora `<header
  class="topbar">` (preserves `badge-mqtt`, `badge-tesla`, `badge-ha`, `badge-loxone`, `badge-ml`,
  `connStatus`, `nowTime` chips + theme-toggle button).
- All 94 binding IDs preserved byte-identical; no JS-side changes required.
- `[hidden]{display:none!important}` normalize added to `settings.css` (Wave-3 addition).

**Per-page invariants for this port:**
- AURORA-02 single-writer (settings.js): no `localStorage.setItem('dvhub.theme', …)`. Grep returns 0.
- VPN tab `data-tab="vpn"` panel preserved; the `#vpnUploadMount` div is the mount point
  `renderVpnUploadPanel()` populates with the upload form + status section.
- VPN profile-name input keeps `pattern="[A-Za-z0-9_-]+"` (Phase 08-12 contract).
- 6 tab anchors survive: `data-tab="connection|control|services|system|ml|vpn"` (1 each).
- Per-slot stopSocPct (hotfix b3c4901): The field `schedule.smallMarketAutomation.minSocPct` is
  JS-generated by settings.js's field generator into `#controlGrid` on the "control" tab. The
  generated `<input>` carries `id="cfg_schedule_smallMarketAutomation_minSocPct"` (from
  `fieldId('schedule.smallMarketAutomation.minSocPct')` at settings.js:608). NOTE: This is
  DIFFERENT from the `#automationMinSocPct` knob on the Leitstand SMA panel — Plan 09.1-05's
  acceptance criteria conflated these two IDs (the planner's reading of the plan is correct in
  intent — preserve the battery-safety knob — but the actual DOM id on settings.html is the
  generated `cfg_schedule_…` form, not `automationMinSocPct`). See settings.spec.mjs for the
  corrected gate.

**Static binding-anchor table** (the 94 IDs the markup carries — JS module references annotated;
the 11 JS-only-injected IDs that the binding-contract heuristic flags as false-positives are
listed in the "Dynamic IDs" section below):

| Semantic slot                                  | Current ID                       | JS module · line         | Notes                                                  |
|------------------------------------------------|----------------------------------|--------------------------|--------------------------------------------------------|
| Page header config meta                        | configMeta                       | settings.js · L?         | Preserve; populated post-load                          |
| Top-of-page Save button (header)               | saveAllHeaderBtn                 | settings.js · L?         | Cmd+S keyboard shortcut target                          |
| Settings banner (loading state)                | settingsBanner                   | settings.js · L613       | Reused for error / progress messages                   |
| Tab — Anlage (Connection)                      | tab-connection / data-tab=conn.  | settings.js · L2455      | Panel container for connectionGrid                     |
| Tab — Steuerung (Control)                      | tab-control / data-tab=control   | settings.js · L2455      | **Hosts stopSocPct field via controlGrid**             |
| Tab — Preise (Services)                        | tab-services / data-tab=services | settings.js · L2455      | Panel container for servicesGrid                       |
| Tab — Status (System)                          | tab-system / data-tab=system     | settings.js · L2455      | Static tab — health, updates, OS, config, history      |
| Tab — ML & AI                                  | tab-ml / data-tab=ml             | settings.js · L2455      | LLM dropdown, ML stats, MAE sparkline                  |
| Tab — VPN                                      | tab-vpn / data-tab=vpn           | settings.js · L2455      | Phase 08-12 — VPN config + upload mount                |
| Connection grid mount                          | connectionGrid                   | settings.js · L1631-34   | Populated by renderDestinationGrid('connection')       |
| Connection banner                              | connectionBanner                 | settings.js · L?         | Per-tab status                                         |
| Control grid mount (SMA panel anchor)          | controlGrid                      | settings.js · L1631-34   | Generates cfg_schedule_smallMarketAutomation_*         |
| Services grid mount                            | servicesGrid                     | settings.js · L1631-34   | Populated by renderDestinationGrid('services')         |
| Save-bar text                                  | saveBarText                      | settings.js · L1660      | Pitfall 6 — dirty-count display                        |
| Save-bar Save button                           | saveConfigBtn                    | settings.js · L?         | POST /api/config                                       |
| Save-bar Discard button                        | discardBtn                       | settings.js · L?         | Restores currentRawConfig into form                    |
| Toast (success/error feedback)                 | settingsAuroraToast              | settings.js · L?         | aria-live=polite                                       |
| Health banner                                  | healthBanner                     | settings.js · L?         | System tab top status                                  |
| Health checks grid                             | healthChecks                     | settings.js · L?         | Sub-system status pills                                |
| Service meta line                              | serviceMeta                      | settings.js · L?         | Live since / version                                   |
| Refresh health btn                             | refreshHealthBtn                 | settings.js · L?         | Re-fetch /api/admin/health                             |
| Update channel select                          | updateChannel                    | settings.js · L?         | stable / dev                                           |
| Update banner                                  | updateBanner                     | settings.js · L?         | Version-checking state                                 |
| Update changelog block                         | updateChangelog                  | settings.js · L?         | Markdown render of release notes                       |
| Update actions block                           | updateActions                    | settings.js · L?         | Apply update button wrapper                            |
| Apply-update button                            | applyUpdateBtn                   | settings.js · L?         | POST /api/admin/update/apply                           |
| Update meta line                               | updateMeta                       | settings.js · L?         | Last-checked timestamp                                 |
| Check-for-update button                        | checkUpdateBtn                   | settings.js · L?         | GET /api/admin/update/check                            |
| System info banner                             | systemInfoBanner                 | settings.js · L?         | Kernel / OS line                                       |
| System updates banner                          | systemUpdatesBanner              | settings.js · L?         | Pending apt updates count                              |
| System updates list                            | systemUpdatesList                | settings.js · L?         | Bullet list of pending pkgs                            |
| System updates actions                         | systemUpdatesActions             | settings.js · L?         | Apply-all button wrapper                               |
| Apply system updates btn                       | applySystemUpdatesBtn            | settings.js · L?         | POST /api/admin/system/updates/apply                   |
| System updates meta                            | systemUpdatesMeta                | settings.js · L?         | Last-scan timestamp                                    |
| Check system updates btn                       | checkSystemUpdatesBtn            | settings.js · L?         | GET /api/admin/system/updates/check                    |
| Service restart btn                            | restartServiceBtn                | settings.js · L?         | POST /api/admin/service/restart                        |
| Reboot system btn                              | rebootSystemBtn                  | settings.js · L?         | POST /api/admin/system/reboot                          |
| Reboot result indicator                        | rebootResult                     | settings.js · L?         | Toast-like inline result                               |
| Import banner                                  | importBanner                     | settings.js · L?         | Config import progress                                 |
| Import meta                                    | importMeta                       | settings.js · L?         | Last-export timestamp                                  |
| Import config file input                       | importConfigFile                 | settings.js · L?         | type=file accept=.json hidden                          |
| Export config btn                              | exportConfigBtn                  | settings.js · L?         | GET /api/config download                               |
| Import config btn                              | importConfigBtn                  | settings.js · L?         | POST /api/config/import                                |
| History banner                                 | historyBanner                    | settings.js · L?         | VRM-historic-import status                             |
| History import start datetime                  | historyImportStart               | settings.js · L?         | datetime-local                                         |
| History import end datetime                    | historyImportEnd                 | settings.js · L?         | datetime-local                                         |
| History import btn                             | historyImportBtn                 | settings.js · L?         | POST /api/history/import                               |
| History backfill btn                           | historyBackfillBtn               | settings.js · L?         | POST /api/history/backfill/vrm                         |
| Refresh history status btn                     | refreshHistoryBtn                | settings.js · L?         | GET /api/history/import/status                         |
| History reason text                            | historyReason                    | settings.js · L?         | Why backfill is recommended                            |
| Full-backfill ack checkbox                     | historyFullBackfillAck           | settings.js · L?         | Required for full re-import                            |
| Extended-lookback toggle                       | historyFullBackfillExtendedLookback | settings.js · L?      | Toggles 14d → 365d slider                              |
| Lookback field wrapper                         | historyFullBackfillLookbackField | settings.js · L?         | hidden until toggle ticked                             |
| Lookback days input                            | historyFullBackfillLookbackDays  | settings.js · L?         | type=number min=1 max=365                              |
| Full-backfill action btn                       | historyFullBackfillBtn           | settings.js · L?         | POST /api/history/backfill/vrm full=true               |
| History import result                          | historyResult                    | settings.js · L?         | Last-run summary                                       |
| DV-log source select                           | dvLogSource                      | settings.js · L?         | ram / db                                               |
| DV-log filter select                           | dvLogFilter                      | settings.js · L?         | all / ctrl / modbus / victron / sma                    |
| DV-log meta                                    | dvLogMeta                        | settings.js · L?         | Count of rows shown                                    |
| Load DV-log btn                                | loadDvLog                        | settings.js · L?         | GET /api/log/dv-signals                                |
| Refresh DV-log btn                             | refreshDvLog                     | settings.js · L?         | Same as load (idempotent)                              |
| DV-log table tbody                             | dvLogRows                        | settings.js · L?         | Rendered rows                                          |
| Modbus scan — unit                             | scanUnit                         | settings.js · L?         | type=number                                            |
| Modbus scan — start                            | scanStart                        | settings.js · L?         | type=number                                            |
| Modbus scan — end                              | scanEnd                          | settings.js · L?         | type=number                                            |
| Modbus scan — step                             | scanStep                         | settings.js · L?         | type=number                                            |
| Modbus scan — qty                              | scanQty                          | settings.js · L?         | type=number                                            |
| Modbus scan — meta                             | scanMeta                         | settings.js · L?         | Result count line                                      |
| Modbus scan — start btn                        | startScan                        | settings.js · L?         | POST /api/meter/scan                                   |
| Modbus scan — rows tbody                       | scanRows                         | settings.js · L?         | Rendered scan results                                  |
| Schedule editor — load btn                     | loadSchedule                     | settings.js · L?         | GET /api/schedule/rules                                |
| Schedule editor — save btn                     | saveSchedule                     | settings.js · L?         | PUT /api/schedule/rules                                |
| Schedule editor — JSON textarea                | scheduleJson                     | settings.js · L?         | Free-form JSON; validated server-side                  |
| Schedule editor — meta                         | scheduleMeta                     | settings.js · L?         | Last-load timestamp                                    |
| ML — model type                                | mlModelType                      | settings.js · L?         | Tier 1 / 2 / 3                                         |
| ML — model version                             | mlModelVersion                   | settings.js · L?         | Semver / git-sha                                       |
| ML — last train                                | mlLastTrain                      | settings.js · L?         | ISO timestamp                                          |
| ML — next train                                | mlNextTrain                      | settings.js · L?         | ETA                                                    |
| ML — MAE sparkline canvas                      | mlMaeSparkline                   | settings.js · L?         | 30-day MAE history                                     |
| ML — MAE 7d                                    | mlMae7d                          | settings.js · L?         | Last-7-days MAE                                        |
| ML — MAE 30d                                   | mlMae30d                         | settings.js · L?         | Last-30-days MAE                                       |
| ML — tier features                             | mlTierFeatures                   | settings.js · L?         | Auto-populated feature list                            |
| ML — training log                              | mlTrainingLog                    | settings.js · L?         | Last 5 runs                                            |
| ML — LLM group (Tier-3 only)                   | mlLlmGroup                       | settings.js · L?         | hidden unless tier=3                                   |
| LLM — model select                             | llmModelSelect                   | settings.js · L1712-15   | TinyLlama / Phi / Mistral / etc.                       |
| LLM — status                                   | llmStatus                        | settings.js · L?         | running / loading / err                                |
| LLM — msg count today                          | llmMsgCount                      | settings.js · L?         | Per-day inferences                                     |
| LLM — avg inference ms                         | llmInferenceMs                   | settings.js · L?         | p50 latency                                            |
| VPN — enabled toggle                           | vpnEnabled                       | settings.js · L?         | data-path="vpn.enabled"                                |
| VPN — protocol select                          | vpnProtocol                      | settings.js · L?         | openvpn / wireguard / ipsec                            |
| VPN — profile name input                       | vpnProfileName                   | settings.js · L?         | **pattern="[A-Za-z0-9_-]+" (Phase 08-12)**             |
| VPN — auto-connect toggle                      | vpnAutoConnect                   | settings.js · L?         | data-path="vpn.autoConnect"                            |
| VPN upload mount                               | vpnUploadMount                   | settings.js · L2259-60   | **renderVpnUploadPanel() mounts here**                 |
| Menu toggle (kept for narrow-viewport burger)  | menuToggle                       | (CSS-only via :checked)  | Wave-3 pattern uses topbar overflow-scroll instead     |

**Dynamic IDs** (JS-injected via `innerHTML` template strings or `el.id = '…'` after `createElement`;
binding-contract.mjs's static regex flags these as missing because the host markup is built at
runtime — the upgraded binding-contract.mjs scans JS files for these patterns and treats them
as provided):

| Dynamic ID                       | Created at settings.js · line | Mount path                                                    |
|----------------------------------|-------------------------------|---------------------------------------------------------------|
| location-picker-map              | settings.js · L847            | inside `overlay.innerHTML = \`…\`` (location-picker modal)    |
| location-picker-coords           | settings.js · L847            | inside `overlay.innerHTML` (location-picker modal)            |
| location-picker-apply            | settings.js · L847            | inside `overlay.innerHTML` (location-picker modal)            |
| forecastTierValue                | settings.js · L1022           | `val.id = 'forecastTierValue'; ...createElement('strong')`    |
| epexBacklogInfo                  | settings.js · L1457           | inside `section.innerHTML = \`…\`` (EPEX provider card)       |
| vpnOvpnFile / vpnCaFile / vpnCertFile / vpnKeyFile / vpnTaFile | settings.js · L2085-2101 | inside `form.innerHTML = \`…\`` in renderVpnUploadPanel       |
| vpnUploadBtn / vpnUploadResult   | settings.js · L2085-2101      | inside renderVpnUploadPanel form.innerHTML                    |
| vpnSettingsStart / Stop / Restart / ActionResult | settings.js · L2113-18 | inside `actionsDiv.innerHTML` in renderVpnUploadPanel        |
| reloadConfigBtn                  | (in tools.js inline render)   | optional — wrapped in `?.addEventListener`, safe if absent    |

**JS-generated form-field IDs** (per `fieldId(path)` at settings.js:608; format `cfg_<path with non-alnum→_>`):
The field generator emits one `<input>` per `definition.fields[i].path` into the destination grid
matching that field's `section.destination`. Critical examples:
- `cfg_schedule_smallMarketAutomation_minSocPct` → control tab → SMA SOC floor (hotfix b3c4901)
- `cfg_schedule_smallMarketAutomation_inverterEfficiencyPct` → control tab
- `cfg_vpn_enabled` etc. — wait, vpn is static; only schedule/connection/services/llm/forecast/ml/etc. are JS-rendered

---

## setup.html (14 static HTML ids · 11 distinct JS-bound ids · all overlap) — FILLED BY WAVE 4 (Plan 09.1-05)

**Counts (2026-05-12 pre-port):**
- `dvhub/public/setup.html` static `id="…"`: **14**
- `dvhub/public/setup.js` distinct `getElementById` ids: **11**
- `.planning/DESIGN-2026-05-10-aurora/setup.html` static `id="…"`: **2** (`app-shell-top`, `app-shell-foot`)
- Shared between current HTML and JS getElementById: 10/11 (1 dynamic — `setupMeta`, injected via `setupGrid` field-generator template)
- Shared between current and Aurora mockup ids: **0** (Aurora mockup is a static stepper wireframe; the actual wizard is JS-state-machine driven)

**Port strategy (Wave 4 — additive restyle, NOT markup replacement).** Setup is a 14-id wizard
with a JS state machine in `setup.js` (1,092 lines). The Wave-4 port mirrors settings.html:
swap link tags, externalise none (already CSP-clean), add `theme.js`. The `setupGrid` container
is what the wizard state machine populates with per-step form fields; the `setupProgress` div
is the stepper visualisation. The legal-section / allowGridCharge / allowGridDischarge wiring
is the §14a EnWG / EEG legal gate (per setup.html L62-88 + project_grid_charge_legal memory rule).

**Per-page invariants for this port:**
- AURORA-02 single-writer (setup.js): no `localStorage.setItem('dvhub.theme', …)`. Grep returns 0.
- All 14 current IDs preserved byte-identical.
- One-shot bootstrap (Phase 08-06): GET `/api/config` is the only init call (no `/api/setup/init`
  endpoint actually exists — the plan's reference to it is shorthand; the bootstrap idempotency
  is enforced server-side by routes-api.js when `setup.complete=true`).
- Legal gate: `#legalAck` checkbox MUST be ticked before `#allowGridCharge` / `#allowGridDischarge`
  enable (the toggles ship `disabled` and setup.js removes the attribute on ack).

**Static binding-anchor table:**

| Semantic slot                          | Current ID               | JS module · line     | Notes                                                                    |
|----------------------------------------|--------------------------|----------------------|--------------------------------------------------------------------------|
| Wizard progress stepper                | setupProgress            | setup.js · L?        | Renders 1..N step pills                                                  |
| Setup banner (loading / error)         | setupBanner              | setup.js · L?        | Mirrors settingsBanner pattern                                           |
| Setup form grid (step content host)    | setupGrid                | setup.js · L?        | Populated by setup.js per active step                                    |
| Legal section wrapper                  | setupLegalSection        | setup.html only      | data-step="legal" — wizard step container                                |
| Legal section heading                  | setupLegalHeading        | setup.html only      | aria-labelledby target                                                   |
| Legal acknowledgement checkbox         | legalAck                 | setup.js · L?        | Enables the 2 legal toggles below                                        |
| Grid-charge toggle                     | allowGridCharge          | setup.js · L?        | EEG/§14a gate; starts disabled                                           |
| Grid-discharge toggle                  | allowGridDischarge       | setup.js · L?        | EEG/§14a gate; starts disabled                                           |
| Import-config row wrapper              | setupImportRow           | setup.html only      | Container for the "import existing" affordance                            |
| Import-config link                     | setupImportLink          | setup.js · L?        | Triggers hidden file input                                               |
| Import-config file input               | setupImportFile          | setup.js · L?        | type=file accept=.json hidden                                            |
| Setup save-bar text                    | setupSaveBarText         | setup.js · L?        | Per-step "X felder benötigt" / "alles bereit" message                    |
| Setup save button                      | setupSaveBtn             | setup.js · L?        | Finalises step / POST /api/config                                        |
| Menu toggle (legacy nav burger)        | menuToggle               | (CSS-only)           | Setup has no real nav — Wave-3 pattern drops/keeps consistently           |

**Dynamic IDs:**

| Dynamic ID    | Created at setup.js · line | Mount path                                                              |
|---------------|----------------------------|-------------------------------------------------------------------------|
| setupMeta     | setup.js · L654 (template) | inside a `setupGrid` field-render template string                       |

---

Family, integrations, explorer, tools, api-docs do NOT need an ID-map (per PATTERNS.md §11).
