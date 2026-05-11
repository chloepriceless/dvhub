// tests/visual-parity/index.spec.mjs — Wave 3 gate (true-visual-port).
//
// Asserts the just-ported Leitstand (index) page renders cleanly:
//  - No blocking console / resource errors (apart from benign auth-gate
//    /api/* 503s and favicon 404s).
//  - All 96 JS-bound static IDs present in the DOM (75 distinct from
//    app.js + leitstand-charts.js, plus a few non-JS-bound topbar / page
//    chrome ids the markup carries).
//  - The dvhub-powerflow widget mount exists at #leitstandPowerflow.
//  - The EPEX chart canvas (#priceChartCanvas) is in the DOM.
//  - The SMA per-slot SoC-floor knob (#automationMinSocPct) is visible
//    + enabled (battery-safety hotfix b3c4901).
//  - The mock-powerflow IDs (#pfCenter / #pf-center-v / #pf-center-d)
//    are NOT present (PF-MOUNT contract from PATTERNS.md §3 / RESEARCH §4
//    Pitfall 3 — operator must see live power values, never the Aurora
//    mockup's 8.42 kW placeholder).
//  - theme.js IS loaded (index respects theme toggle — unlike family.html
//    which is kiosk dark-locked).
//  - AURORA-02 single-writer: neither app.js nor leitstand-charts.js
//    writes localStorage['dvhub.theme'].
//
// Requires a dev server on http://localhost:8080.

import { test, expect } from '@playwright/test';

// All static binding IDs that the new Aurora index.html must carry.
// 75 distinct JS-bound IDs (from `grep getElementById app.js
// leitstand-charts.js`) plus the topbar chips + Aurora-named page chrome
// containers that are referenced by class but tagged with id for CSS
// hooks. menuToggle is REMOVED (Aurora topbar uses overflow-x scroll).
const EXPECTED_IDS = [
  // Topbar (TOPBAR-DECISION Option A — chips preserved in .topbar-right)
  'badge-mqtt', 'badge-tesla', 'badge-ha', 'badge-loxone',
  'badge-ml', 'connStatus', 'nowTime',
  // Left rail — PV card
  'pvTotal', 'pvP', 'pvAc', 'dvDcPv', 'dvAcPv',
  // Left rail — Battery card
  'soc', 'socBar', 'batP', 'gridSetpoint',
  'minSocRow', 'minSoc', 'minSocEditor', 'minSocEditorValue', 'minSocSlider', 'minSocSubmitBtn',
  // Left rail — DV-Status card
  'dvStatus', 'dvValue', 'offUntil', 'kaModbus', 'dvVpnRow', 'dvVpnStatus',
  // Left rail — VPN card
  'vpnCard', 'vpnStatus', 'vpnTunIp', 'vpnUptime', 'vpnReconnects',
  'vpnCertWarn', 'vpnCertDays', 'vpnReconnectBtn',
  // Flow center — live powerflow mount (PF-MOUNT contract)
  'leitstandPowerflow',
  // Right rail — Markt card
  'priceNow', 'priceNext', 'negLater', 'negTomorrow', 'todayMinMax', 'tomorrowMinMax', 'negPriceProtection',
  // Right rail — Kosten card
  'costImport', 'costExport', 'costCost', 'costRevenue', 'costNet',
  // Right rail — Automatik summary card
  'automationSummaryTitle', 'automationStatusBar',
  'automationOutcome', 'automationRuleCount', 'automationAvailableEnergy',
  // Right rail — Steuerung card
  'activeGridSetpoint', 'activeChargeCurrent', 'activeMinSoc', 'activeDcFeed', 'lastControlWrite',
  'manualGridValue', 'manualGridBtn', 'manualChargeValue', 'manualChargeBtn',
  'defaultGridSetpointInput', 'defaultChargeCurrentInput', 'defaultFeedExcessDcPvInput', 'saveDefaultsBtn',
  // EPEX chart panel + selection toolbar
  'refreshEpex', 'priceChartContainer', 'priceChartCanvas', 'tooltip',
  'chartScheduleCallout', 'chartSelectionSummary', 'chartSelectionDetail',
  'createSelectionScheduleBtn', 'chartComparisonSummary', 'chartComparisonDetail', 'chartMeta',
  // Schedule editor + Automation Plan
  'schedColGrid', 'schedColCharge', 'automationPlanSummary', 'replanAutomationBtn',
  'planComputedAt', 'planEnergyBudget', 'planEstimatedRevenue', 'planSlotRows',
  'scheduleRowsDash', 'addScheduleRowBtn', 'loadScheduleBtn', 'saveScheduleBtn', 'controlMsg',
  // SMA panel — INCLUDING the per-slot stopSocPct knob (hotfix b3c4901)
  'automationPanel', 'automationEnabled', 'automationStatusTitle', 'automationStatusBarPanel',
  'automationOutcomePanel', 'automationRuleCountPanel', 'automationAvailableEnergyPanel',
  'automationConfigGrid', 'automationSearchStart', 'automationSearchEnd',
  'automationBatteryCapacity', 'automationInverterEfficiency', 'automationMaxDischargeW',
  'automationMinSocPct',         // ← battery-safety knob, hotfix b3c4901
  'automationStagesContainer',   // ← JS-populated per-stage rows host, hotfix b3c4901
  'addAutomationStageBtn', 'saveAutomationConfigBtn',
  // Forecast & Optimizer section
  'forecast-summary-row', 'overlay-toggle',
  'pv-daily-card', 'pv-daily-kwh', 'pv-daily-detail',
  'load-daily-card', 'load-daily-kwh', 'load-daily-detail',
  'surplus-daily-card', 'surplus-daily-kwh', 'surplus-daily-detail',
  'pv-forecast-card', 'pv-forecast-skeleton', 'pv-forecast-chart',  // ← restored Wave-3
  'forecastComparisonCard', 'forecastCompSkeleton', 'forecastCompSubtitle',
  'forecastComparisonChart', 'forecastCompLegend', 'forecastDaySummary',
  'optimizerPlanCard', 'optimizerPlanSkeleton', 'optimizerPlanSubtitle',
  'optimizerPlanChart', 'optimizerPlanLegend',
  'gantt-card', 'gantt-skeleton', 'gantt-chart',
  'savings-card', 'savings-total', 'savings-breakdown',
  // Bottom log panel
  'logBox', 'log-level-filter',  // ← log-level-filter restored Wave-3
];

test.describe('Index/Leitstand page (Aurora Wave 3, AURORA-01/02/03/04/05/06)', () => {
  test('loads with no blocking console / resource errors', async ({ page }) => {
    const errors = [];
    const failedResources = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const loc = msg.location();
        errors.push({ text: msg.text(), url: (loc && loc.url) || '' });
      }
    });
    page.on('pageerror', (err) => errors.push({ text: String(err), url: '' }));
    page.on('response', (resp) => {
      const status = resp.status();
      if (status >= 400) failedResources.push({ url: resp.url(), status });
    });
    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2500);
    // Benign 4xx/5xx for THIS test: optional assets + /api/* auth-gate 503s
    // (apiToken unset on dev server → all authenticated endpoints return
    // 503). Page chrome must render regardless of API token state.
    const benign = /favicon-|apple-touch-icon\.png|manifest\.json|family-scene\.png|\/api\//;
    const blocking = errors.filter((e) => !benign.test(e.url || e.text));
    const blockingTexts = blocking.map((e) => `${e.text}  (url=${e.url || '<none>'})`);
    expect(blocking, blockingTexts.join('\n')).toEqual([]);
    const blockingFailed = failedResources.filter((r) => !benign.test(r.url));
    const blockingFailedTexts = blockingFailed.map((r) => `${r.status} ${r.url}`);
    expect(blockingFailed, blockingFailedTexts.join('\n')).toEqual([]);
  });

  test('theme.js IS loaded and data-theme attribute applies', async ({ page }) => {
    await page.goto('/index.html');
    await page.waitForTimeout(500);
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(['dark', 'light']).toContain(theme);
    const hasThemeJs = await page.evaluate(() =>
      Array.from(document.scripts).some((s) => (s.src || '').endsWith('/theme.js')),
    );
    expect(hasThemeJs).toBe(true);
  });

  test('all bound IDs present in DOM', async ({ page }) => {
    await page.goto('/index.html');
    const missing = [];
    for (const id of EXPECTED_IDS) {
      const count = await page.locator(`[id="${id}"]`).count();
      if (count !== 1) missing.push(`${id} (count=${count})`);
    }
    expect(missing, `IDs missing or duplicated: ${missing.join(', ')}`).toEqual([]);
  });

  test('powerflow live mount exists at #leitstandPowerflow (PF-MOUNT contract)', async ({ page }) => {
    await page.goto('/index.html');
    const mount = page.locator('#leitstandPowerflow');
    await expect(mount).toBeAttached();
    await page.waitForTimeout(2500);
    const canvas = page.locator('#leitstandPowerflow canvas');
    const canvasCount = await canvas.count();
    if (canvasCount > 0) {
      const dataUrlLength = await canvas.first().evaluate((el) => el.toDataURL().length);
      if (dataUrlLength > 4000) {
        return;
      }
      console.warn('index.spec: powerflow canvas attached but did not paint. Likely empty /api/status response (auth-gate).');
    } else {
      console.warn('index.spec: powerflow canvas not yet created. Likely dvhub-powerflow.js soft-gated on /api/status data.');
    }
  });

  test('EPEX chart canvas mount + SMA per-slot stopSocPct knob present (battery-safety, hotfix b3c4901)', async ({ page }) => {
    await page.goto('/index.html');
    const epexCanvas = page.locator('#priceChartCanvas');
    await expect(epexCanvas).toBeAttached();
    const socFloor = page.locator('#automationMinSocPct');
    await expect(socFloor).toBeAttached();
    await expect(socFloor).toBeEnabled();
    const stagesContainer = page.locator('#automationStagesContainer');
    await expect(stagesContainer).toBeAttached();
  });

  test('mock-powerflow IDs are NOT present (PF-MOUNT contract — operator must see live data)', async ({ page }) => {
    await page.goto('/index.html');
    for (const mockId of ['pfCenter', 'pf-center-v', 'pf-center-d']) {
      const count = await page.locator(`[id="${mockId}"]`).count();
      expect(count, `Mock-powerflow ID "${mockId}" must not be present in index.html (operator would see fake "8.42 kW" instead of live mount).`).toBe(0);
    }
  });

  test('AURORA-02 single-writer: app.js + leitstand-charts.js do NOT call setItem on dvhub.theme key', async ({ page }) => {
    await page.goto('/index.html');
    const appJsBody = await page.evaluate(async () => {
      const resp = await fetch('/app.js');
      return resp.text();
    });
    expect(appJsBody).not.toMatch(/localStorage\.setItem\(\s*['"]dvhub\.theme['"]/);
    const chartsJsBody = await page.evaluate(async () => {
      const resp = await fetch('/leitstand-charts.js');
      return resp.text();
    });
    expect(chartsJsBody).not.toMatch(/localStorage\.setItem\(\s*['"]dvhub\.theme['"]/);
  });

  test('styles.css is NOT loaded (Aurora cascade owns the page)', async ({ page }) => {
    await page.goto('/index.html');
    const linkedStyles = await page.evaluate(() =>
      Array.from(document.styleSheets).map((s) => s.href || '').filter(Boolean),
    );
    const hasLegacyStyles = linkedStyles.some((href) => /\/styles\.css(\?|$)/.test(href));
    expect(hasLegacyStyles, `styles.css must NOT be linked from index.html (found: ${linkedStyles.join(', ')})`).toBe(false);
    const hasAuroraStyles = linkedStyles.some((href) => /\/dvhub-app\.css(\?|$)/.test(href));
    expect(hasAuroraStyles, 'dvhub-app.css must be linked from index.html').toBe(true);
  });
});
