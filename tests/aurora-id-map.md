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

## index.html (138 current → 39 Aurora, 0 shared) — TO BE FILLED BY WAVE 3 PRE-WORK

| Semantic slot (Aurora)        | Aurora ID            | Current ID          | JS module · line   | Notes                                                  |
|-------------------------------|----------------------|---------------------|--------------------|--------------------------------------------------------|
| Powerflow mount               | (none — class-only)  | leitstandPowerflow  | app.js · L136      | Live mount point; preserve current ID byte-for-byte    |
|                               |                      |                     |                    |                                                        |

(38 more rows to fill — extracted from `comm -23 <(extract index.html IDs) <(extract Aurora index.html IDs)`)

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
