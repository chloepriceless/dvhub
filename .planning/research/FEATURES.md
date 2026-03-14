# Feature Landscape

**Domain:** Home Energy Management System (HEMS) with Direktvermarktung focus for the German market
**Researched:** 2026-03-14

## Table Stakes

Features users expect. Missing = product feels incomplete.

### Energy Monitoring & Visualization

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Real-time power flow display (PV, battery, grid, load) | Every HEMS shows this — HA Energy Dashboard, SolarAssistant, SENEC all have it. Users orient themselves by "where is my power going right now?" | Medium | DVhub already has basic live view. Needs animated flow diagram like HA power-flow-card. |
| Battery SoC gauge with history | Core metric for any battery owner. Without it, users check Victron VRM instead of DVhub. | Low | Already partially exists in DVhub telemetry. |
| Daily/weekly/monthly energy summaries | SolarAssistant, HA Energy Dashboard, Senec app all provide kWh totals per period. Autarky rate is the metric German PV owners care most about. | Medium | DVhub has history views with aggregation. Needs Autarkiegrad (self-sufficiency %) and Eigenverbrauchsquote (self-consumption %). |
| EPEX day-ahead price chart | Dynamic tariff users (Tibber, aWATTar) and DV operators both need to see upcoming prices. Standard in every German energy app since 2024. | Low | Already exists in DVhub. **Must support 15-minute resolution** since EPEX switched to 15-min MTU on 2025-10-01 (96 prices/day instead of 24). |
| Cost/revenue tracking | Users want EUR values, not just kWh. "What did I earn from feed-in today?" and "What did grid import cost?" | Medium | DVhub has `costSummary()`. Needs to handle dynamic tariff periods, DV revenue vs EEG Verguetung, and show net position. |

### Battery & Inverter Control

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Grid setpoint control | Core ESS control. Every Victron HEMS (Node-RED, Venus OS large, HA automations) uses register 2700 or Mode 3 registers 37-41. | Low | Already exists via Modbus TCP write. DVhub's core capability. |
| Charge current limiting | Needed for battery protection and optimization strategies (e.g., slow charge from grid at night). | Low | Already exists in DVhub schedule rules (`chargeCurrentA` target). |
| Min SoC protection | Users expect a safety floor. All commercial HEMS (SENEC, sonnen, E3/DC) enforce this. | Low | Already exists in DVhub. |
| Schedule rules (time-based automation) | Basic automation: "charge battery between 02:00-05:00 when prices are low." Every HEMS has time-based rules. | Low | Already exists with start/end time windows and stopSocPct. |
| Manual override with TTL | Users need to override automation temporarily ("force charge now for 2 hours"). Commercial systems all have this. | Low | Exists as `manualOverrideTtlMs` concept but not fully wired. |

### Integration Endpoints

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Home Assistant integration API | HA is the dominant smart home platform in the German PV community. Not having an HA integration is a dealbreaker. | Low | Already exists at `/api/integration/home-assistant`. Needs MQTT discovery for automatic entity creation. |
| EOS optimizer integration | Akkudoktor EOS is the most popular open-source optimizer in the German community (Dr. Andreas Schmitz / @akkudoktor on YouTube). The `/api/integration/eos` endpoint must provide measurement data and accept optimization results. | Medium | Already exists (GET state + POST apply). EOS expects `battery_soc` as 0-1 fraction, `pv_power` in W, `load_power` in W. DVhub already formats this correctly. Needs auto-trigger support (EOS v0.2+ can auto-optimize). |
| EMHASS optimizer integration | Second most popular optimizer. Python-based, uses Linear Programming (CVXPY). Needs `soc_init`, `load_cost_forecast`, `pv_power_forecast`. | Medium | Already exists at `/api/integration/emhass`. Format matches EMHASS expectations (soc as 0-1, prices as EUR/kWh arrays). |

### Data Persistence & Export

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| InfluxDB export | Standard for long-term monitoring with Grafana. Every serious PV monitoring setup uses InfluxDB + Grafana. | Low | Already exists. Supports v2 and v3. |
| History with rollups | Users expect to see months/years of data without the system slowing down. 15min/1hr aggregation is standard. | Low | Already exists with 5min, 15min, 1hr rollup intervals and 45-day raw retention. |
| Config backup/restore | Users expect to save and restore their configuration. Essential for system reinstalls. | Low | Already exists via `/api/config/export` and `/api/config/import`. |

## Differentiators

Features that set DVhub apart. Not expected in every HEMS, but valued in the DV/prosumer niche.

### Direktvermarktung (DV) Features

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Curtailment response (Abregelung) | DV operators (LUOX, Next Kraftwerke, energy2market) send power reduction commands. DVhub can respond by adjusting grid setpoint. Most small-system HEMS ignore this entirely. The DV interface typically uses VPN + Modbus/SunSpec for control, or digital I/O via Rundsteuerempfaenger (4-step: 0%/30%/60%/100%). **Proportional curtailment (0-100%)** via Modbus is technically possible but not universally supported by all DV partners. | High | DVhub already has `dvControlValue` and `forcedOff` state. Needs formalization: accept curtailment commands, translate to grid setpoint adjustment, report compliance state back. |
| Marktwertberechnung (market value calculation) | Calculate actual DV revenue using EPEX market values + Marktpraemie. Show "Marktwert Solar" vs "EEG-Verguetung" comparison. BNetzA publishes applicable values monthly. | Medium | DVhub already scrapes BNetzA applicable values and has `userEnergyPricing`. Needs monthly Marktwert Solar aggregation and Marktpraemie calculation. |
| Pauschaloption/MISPEL support | New regulation (EEG 2025, final rules expected H1 2026) enables battery grid charging while keeping EEG subsidy for systems up to 30 kWp. 500 kWh/kWp annual cap tracking. Only needs single bidirectional smart meter. **First-mover advantage**: no open-source HEMS supports this yet. | High | Not yet implemented. Needs: annual energy accounting per kWp, cap tracking with warnings, correct separation of grid-charged-then-exported kWh vs PV-generated kWh. Data model must track energy provenance. |
| Small market automation (Boersenautomatik) | Price-optimized battery dispatch for small DV systems. Buy low (grid charge at negative prices), sell high (feed-in at peak prices). DVhub already has `smallMarketAutomation` with multi-stage chain variants. | Medium | Already exists and recently enhanced. Key differentiator vs commercial HEMS that only do self-consumption optimization. |

### Advanced Tariff Support

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Paragraph 14a Modul 3 (time-variable network charges) | From 2025-04-01, Modul 3 offers time-variable Netzentgelte with Hochtarif/Standardtarif/Niedertarif windows. DVhub can shift loads to Niedertarif windows for maximum savings. Requires iMSys (smart meter). Most HEMS ignore network charge optimization. | Medium | DVhub already has `usesParagraph14aModule3` flag and `module3Windows` config structure with 3 configurable time windows. Needs: automatic schedule rule generation from windows, cost calculation integration, visualization of tariff periods on timeline. |
| Multi-period pricing model | Support fixed-price periods AND dynamic pricing periods within the same year (e.g., "fixed winter, dynamic summer"). Real-world pattern for German prosumers switching between contracts. | Medium | DVhub already has `userEnergyPricing.periods` with per-period mode (fixed/dynamic). Needs dashboard visualization and correct period-aware cost calculations. |
| 15-minute EPEX resolution | Since 2025-10-01, EPEX Day-Ahead delivers 96 quarter-hourly prices instead of 24 hourly. Systems using hourly prices leave money on the table (up to 15% price spread within an hour during solar peaks). | Medium | DVhub currently fetches from energy-charts.info API. **Must verify** if energy-charts.info already serves 15-min data or needs a new data source (EPEX SPOT directly, Tibber API, aWATTar API). evcc already has an issue tracking 15-min support (#20960). |

### EVCC Integration

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| EVCC state reading | Read EV charging state (mode, power, SoC, plan) from EVCC's REST API (`GET /api/state`). Display EV charging as part of the energy flow. Include EV consumption in cost calculations. EVCC is the dominant open-source EV charging controller in Germany. | Medium | Not yet implemented. EVCC API is well-documented, returns JSON with loadpoints, grid, PV, battery state. Authentication via cookie from `POST /api/auth/login`. Breaking change in v0.207: outer `result` wrapper removed. |
| Coordinated battery/EV optimization | Use DVhub's EPEX price data to inform EVCC's smart charging decisions. EVCC already has `smartcostlimit` API and tariff integration. DVhub can push tariff data or coordinate charge windows. | High | EVCC has its own tariff sources (Tibber, aWATTar, energy-charts). Coordination layer avoids competing optimizations (DVhub charges battery while EVCC charges car simultaneously). |

### Dashboard Enhancements

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Animated power flow diagram | The "sankey-style" or "circle flow" diagram (like HA power-flow-card-plus) is the visual people screenshot and share. PV -> Battery -> House -> Grid with animated dots showing direction and magnitude. | Medium | DVhub's frontend is vanilla JS, no framework. Can implement with SVG + CSS animations. |
| Price-overlay on energy timeline | Show EPEX prices as a color gradient behind the energy production/consumption chart. Immediately shows "did I export during expensive hours?" | Medium | DVhub has history charts. Adding a price overlay layer makes DV economics visible at a glance. |
| Forecast display (PV + load) | Show tomorrow's expected PV generation and household load. EOS and EMHASS both generate forecasts. Display them so users can anticipate and plan. | Medium | Needs forecast data source — either from EOS optimization result, EMHASS publish, or separate PV forecast API (Solcast, forecast.solar). |
| Mobile-responsive layout | German PV owners check their system on phones. SENEC has an app, SolarAssistant works on mobile. DVhub must be usable on phone screens. | Medium | Current DVhub frontend is desktop-oriented. Needs responsive CSS, touch-friendly controls. |

### Multi-Inverter Support

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Deye/Sunsynk Modbus support | Deye (and rebadged Sunsynk/Sol-Ark) is the fastest-growing inverter brand in Germany. Uses Modbus RTU with proprietary register map (partially documented, same across Sunsynk/Deye/Sol-Ark). | High | DVhub is currently Victron-only. Deye register maps are available from community efforts. Needs abstraction layer for inverter control. |
| SMA SunSpec Modbus support | SMA is the market leader in Germany. Uses SunSpec-compliant Modbus (with some quirks — WMaxLimEna cannot be written cyclically). Sunny Home Manager 2.0 is common but limited; Data Manager M is the serious platform. | High | Requires SunSpec Modbus client implementation. SMA has specific power limiting quirks. |
| Fronius SunSpec Modbus support | Fronius GEN24 is popular in Austria/Germany. Full SunSpec v2 compliance over Modbus TCP. Best-documented SunSpec implementation. | Medium | Fronius is the easiest non-Victron inverter to add due to clean SunSpec compliance. Good candidate for first multi-inverter expansion. |
| Huawei SUN2000 support | Popular in Germany. Modbus TCP via SmartDongle (firmware 120+) or SmartLogger. Less standardized than SunSpec — partially proprietary register map. | High | Complex due to dongle firmware dependencies and inconsistent Modbus access methods. |

## Anti-Features

Features to explicitly NOT build.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Cloud dependency / account system | DVhub's core value is local-first, privacy-respecting operation. Adding cloud accounts or requiring internet breaks trust and reliability (solar systems must work during outages). SENEC's internet requirement is widely criticized. | Keep LAN-only operation. Optional remote access via VPN or Tailscale is the user's choice. |
| Built-in EV charger control | EVCC already does this perfectly with 80+ charger integrations, OCPP support, and solar-surplus charging. Duplicating EVCC's work is wasteful and will always be inferior. | Integrate WITH EVCC via its REST API. Read state, coordinate optimization, but let EVCC handle charger hardware. |
| Built-in optimizer (LP/genetic algorithm) | EOS and EMHASS are purpose-built optimizers with active communities. Building a competing optimizer splits effort and won't match their quality. | Provide excellent integration endpoints for EOS and EMHASS. Focus on being the best data provider and actuator, not the brain. |
| Proprietary hardware/dongle requirement | Requiring specific hardware (like Tibber Pulse or SENEC's locked ecosystem) limits adoption and creates vendor lock-in. | Support standard protocols (Modbus TCP/RTU, MQTT, SunSpec). Work with what users already have. |
| Smart home device control (lights, plugs, thermostats) | Home Assistant, openHAB, and ioBroker handle general home automation far better. A HEMS controlling light bulbs is scope creep. | Expose integration APIs so HA/openHAB can read DVhub state and make their own automation decisions. |
| App store / plugin system | Massive engineering effort for minimal value at DVhub's scale. Plugin APIs create backwards-compatibility burdens. | Keep a clean REST API. Third-party integrations connect via HTTP/MQTT, not plugins. |
| Multi-site / fleet management | Fleet management is a different product (for installers, not homeowners). Adds complexity without benefiting the core user. | Each DVhub instance manages one site. Monitoring tools like Grafana can aggregate multiple instances if needed. |
| Weather station integration | Temperature, wind, humidity data is interesting but not actionable for energy optimization. EOS/EMHASS handle weather-dependent forecasting. | Let optimizers consume weather data. DVhub does not need to know the weather directly. |

## Feature Dependencies

```
EPEX 15-min resolution --> Small Market Automation (needs granular prices)
EPEX 15-min resolution --> Tariff cost calculations (accuracy improvement)

Pauschaloption/MISPEL --> Energy provenance tracking (must know: was this kWh from PV or grid?)
Pauschaloption/MISPEL --> Annual cap monitoring (500 kWh/kWp tracking)

EVCC Integration (read) --> Coordinated battery/EV optimization
EVCC Integration (read) --> Power flow diagram (show EV as consumer)

EOS/EMHASS integration --> Forecast display (optimization results contain forecasts)
EOS/EMHASS integration --> Automated schedule generation (apply optimization to schedule rules)

Inverter abstraction layer --> Deye support
Inverter abstraction layer --> SMA support
Inverter abstraction layer --> Fronius support
Inverter abstraction layer --> Huawei support

Paragraph 14a Modul 3 config --> Schedule rule auto-generation from tariff windows
Paragraph 14a Modul 3 config --> Cost calculation with time-variable Netzentgelte

Power flow diagram --> Mobile-responsive layout (must look good on phones)
Price-overlay timeline --> EPEX 15-min resolution (granular overlay)
```

## MVP Recommendation

**For the HEMS expansion milestone, prioritize in this order:**

### Must-Have (Phase 1)

1. **EPEX 15-minute resolution** — The market switched in October 2025. Operating on hourly data is already outdated and leaves optimization value on the table. Foundation for all price-dependent features.
2. **Power flow diagram** — The most visible, most-shared feature of any HEMS. Users need to "see" their energy system working. Without this, DVhub feels like a developer tool, not a product.
3. **Self-sufficiency and self-consumption metrics** — Autarkiegrad and Eigenverbrauchsquote are the two numbers every German PV owner cares about. Must appear on the dashboard.
4. **Mobile-responsive layout** — If users can't check their system on the phone, they'll check VRM or SolarAssistant instead.

### Should-Have (Phase 2)

5. **EVCC state integration** — Read EVCC data, show EV charging in the flow diagram, include in cost calculations. Passive integration first (read-only).
6. **Paragraph 14a Modul 3 visualization** — Show tariff windows on the timeline, calculate savings from load shifting. The config structure already exists.
7. **Forecast display** — Show PV and load forecasts from EOS/EMHASS. Makes the optimizer integration visible to users.
8. **Price-overlay on energy timeline** — Color-code the history chart by EPEX price. Makes DV economics intuitive.

### Defer

- **Pauschaloption/MISPEL**: Final BNetzA rules not published yet (expected H1 2026). Market rollout expected late 2026/early 2027. Build when regulations are finalized.
- **Multi-inverter support (Deye, SMA, Fronius, Huawei)**: Major architectural change (inverter abstraction layer). Pursue after core HEMS features are solid. Start with Fronius (cleanest SunSpec).
- **Coordinated battery/EV optimization**: Requires both EVCC integration and robust optimizer integration to be mature. Complex coordination logic.

## Sources

- [EVCC REST API Documentation](https://docs.evcc.io/docs/integrations/rest-api)
- [Akkudoktor EOS GitHub](https://github.com/Akkudoktor-EOS/EOS)
- [EOS Optimization Documentation](https://akkudoktor-eos.readthedocs.io/en/latest/akkudoktoreos/optimization.html)
- [EOS Connect](https://github.com/ohAnd/EOS_connect)
- [EMHASS Documentation](https://emhass.readthedocs.io/)
- [EMHASS GitHub](https://github.com/davidusb-geek/emhass)
- [Victron ESS Mode 2 and 3](https://www.victronenergy.com/live/ess:ess_mode_2_and_3)
- [SolarAssistant Dashboard](https://solar-assistant.io/help/dashboard/overview)
- [SENEC PowerPilot](https://senec.com/de/produkte/senec-powerpilot)
- [Home Assistant Energy Cards](https://www.home-assistant.io/dashboards/energy/)
- [Power Flow Card Plus (HA custom card)](https://github.com/flixlix/power-flow-card-plus)
- [Bundesnetzagentur Paragraph 14a](https://www.bundesnetzagentur.de/DE/Beschlusskammern/BK06/BK6_83_Zug_Mess/841_SteuVE/BK6_SteuVE_node.html)
- [BNetzA MiSpeL](https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/ErneuerbareEnergien/EEG_Aufsicht/MiSpeL/artikel.html)
- [gridX MiSpeL Explainer](https://www.gridx.ai/knowledge/everything-you-need-to-know-about-mispel)
- [Next Kraftwerke Day-Ahead 15-min Switch](https://www.next-kraftwerke.com/energy-blog/day-ahead-switch-15-min)
- [EPEX SPOT 15-minute Products](https://www.epexspot.com/en/15-minute-products-market-coupling)
- [evcc 15-min EPEX Issue #20960](https://github.com/evcc-io/evcc/issues/20960)
- [SMA Direktvermarktungsschnittstelle Technical Information](https://files.sma.de/downloads/Direktvermarktung-TI-de-11.pdf)
- [Fronius Modbus TCP](https://www.fronius.com/en-us/usa/solar-energy/installers-partners/technical-data/all-products/system-monitoring/open-interfaces/modbus-tcp)
- [Victron dbus-fronius (SunSpec Modbus driver)](https://github.com/victronenergy/dbus-fronius)
- [Tibber Developer API](https://developer.tibber.com/)
- [aWATTar API](https://www.awattar.de/services/api)
- [1KOMMA5 Paragraph 14a Explainer](https://1komma5.com/de/strommarkt/paragraf-14a-enwg-steuerbare-verbrauchseinrichtungen/)
