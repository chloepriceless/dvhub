const common = window.DVhubCommon || {};
const { apiFetch } = common;

const historyChartInstances = {};

const historyState = {
  loading: false,
  backfillBusy: false,
  lastSummary: null,
  chartCursorByMount: {},
  aggregateModeByView: {},
  detailsExpanded: false,
  statusInfoExpanded: false,
  statusInfoHtml: ''
};

function currentDateValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function byId(id) {
  return typeof document !== 'undefined' ? document.getElementById(id) : null;
}

function setText(id, value) {
  const element = byId(id);
  if (element) element.textContent = value;
}

function setHtml(id, value) {
  const element = byId(id);
  if (element) element.innerHTML = value;
}

function setHidden(id, hidden) {
  const element = byId(id);
  if (element) element.hidden = Boolean(hidden);
}

function valueOf(item, key) {
  return Number(item?.[key] || 0);
}

function setBanner(text, kind = 'info') {
  const banner = byId('historyBanner');
  if (!banner) return;
  banner.className = `status-banner ${kind}`;
  setText('historyBannerText', text);
}

function renderStatusInfo() {
  const toggle = byId('historyStatusInfoToggle');
  const info = byId('historyStatusInfo');
  if (toggle) {
    toggle.hidden = !historyState.statusInfoHtml;
    toggle.textContent = historyState.statusInfoExpanded ? 'Info ausblenden' : 'Info';
    toggle.ariaExpanded = historyState.statusInfoExpanded ? 'true' : 'false';
  }
  if (info) {
    info.innerHTML = historyState.statusInfoHtml;
    info.hidden = !historyState.statusInfoExpanded;
  }
}

function setStatusInfo(html = '') {
  historyState.statusInfoHtml = html;
  renderStatusInfo();
}

function round2(value) {
  const numeric = Number(value || 0);
  const sign = numeric < 0 ? -1 : 1;
  return sign * (Math.round((Math.abs(numeric) + Number.EPSILON) * 100) / 100);
}

function hasFiniteNumber(value) {
  return value !== null && value !== '' && Number.isFinite(Number(value));
}

function fmtEur(value) {
  if (!Number.isFinite(Number(value))) return '-';
  return `${Number(value).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function fmtKwh(value) {
  if (!Number.isFinite(Number(value))) return '-';
  return `${Number(value).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kWh`;
}

function fmtCt(value) {
  if (!Number.isFinite(Number(value))) return '-';
  return `${Number(value).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ct/kWh`;
}

function fmtHours(value) {
  if (!Number.isFinite(Number(value))) return '-';
  return `${Number(value).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} h`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderBackfillButtonState() {
  const button = byId('historyBackfillBtn');
  if (!button) return;
  button.disabled = historyState.backfillBusy;
  button.textContent = historyState.backfillBusy ? 'Preise werden geladen...' : 'Preise nachladen';
}

function renderKpis(summary) {
  const kpis = summary?.kpis;
  const cost = importCostEur(kpis);
  const pvCost = kpis?.pvCostEur || 0;
  const batCost = kpis?.batteryCostEur || 0;
  const totalCost = round2(cost + pvCost + batCost);
  const revenue = kpis?.exportRevenueEur || 0;
  const net = cashNetEur(kpis);
  const avoided = kpis?.avoidedImportGrossEur || 0;
  const gross = grossReturnEur(kpis);

  // Karte 1: Energiekosten
  setText('historyKpiTotalCost', fmtEur(-Math.abs(totalCost)));
  setText('historyKpiCost', fmtEur(-Math.abs(cost)));
  setText('historyKpiAvoidedPvCost', fmtEur(-Math.abs(pvCost)));
  setText('historyKpiAvoidedBatteryCost', fmtEur(-Math.abs(batCost)));

  // Karte 2: Energieeinnahmen
  setText('historyKpiTotalRevenue', fmtEur(revenue));
  setText('historyKpiRevenue', fmtEur(revenue));

  // Karte 3: Netto Cashflow
  setText('historyKpiNet', fmtEur(net));
  setText('historyKpiCashIn', fmtEur(revenue));
  setText('historyKpiCashOut', fmtEur(-Math.abs(cost)));

  // Karte 4: Vermiedene Kosten (Bezugspreis-Modus)
  const oppCost = kpis?.opportunityCostEur || 0;
  const oppCostPv = kpis?.opportunityCostPvEur || 0;
  const oppCostBat = kpis?.opportunityCostBatteryEur || 0;
  const avoidedPv = kpis?.avoidedImportPvGrossEur || 0;
  const avoidedBat = kpis?.avoidedImportBatteryGrossEur || 0;
  // Store for toggle
  window._historyKpiCache = { avoided, avoidedPv, avoidedBat, oppCost, oppCostPv, oppCostBat, net, gross, pvCost, batCost };
  setText('historyKpiAvoided', fmtEur(avoided));
  setText('historyKpiAvoidedPvGross', fmtEur(avoidedPv));
  setText('historyKpiAvoidedBatteryGross', fmtEur(avoidedBat));
  // Marktwert-Modus Werte
  setText('historyKpiAvoidedPvMarket', fmtEur(round2(avoidedPv - oppCostPv)));
  setText('historyKpiAvoidedBatMarket', fmtEur(round2(avoidedBat - oppCostBat)));
  setText('historyKpiOppCost', fmtEur(-Math.abs(oppCost)));

  // Karte 5: Energiebilanz
  setText('historyKpiPv', fmtKwh(kpis?.pvKwh));
  setText('historyKpiSelfCons', fmtKwh(kpis?.selfConsumptionKwh));
  setText('historyKpiImport', fmtKwh(kpis?.importKwh));
  setText('historyKpiExport', fmtKwh(kpis?.exportKwh));
  setText('historyKpiVbh', hasFiniteNumber(kpis?.pvFullLoadHours) ? fmtHours(kpis?.pvFullLoadHours) : '-');

  // Karte 6: Gesamtbilanz
  setText('historyKpiGrossReturn', fmtEur(gross));
  setText('historyKpiBilanzAvoided', fmtEur(avoided));
  setText('historyKpiBilanzNet', fmtEur(net));
  setText('historyKpiBilanzPvCost', fmtEur(-Math.abs(pvCost)));
  setText('historyKpiBilanzBatCost', fmtEur(-Math.abs(batCost)));

  // Gesamtbilanz Karte: grün bei positiv, orange bei negativ
  const bilanzCard = document.getElementById('historyKpiBilanzCard');
  if (bilanzCard) {
    const isPositive = gross >= 0;
    bilanzCard.dataset.accent = isPositive ? 'green' : 'orange';
    const bilanzValue = document.getElementById('historyKpiGrossReturn');
    if (bilanzValue) bilanzValue.style.color = isPositive ? 'var(--flow-green)' : 'var(--flow-orange)';
    const bilanzKicker = bilanzCard.querySelector('.config-group-kicker');
    if (bilanzKicker) bilanzKicker.style.color = isPositive ? 'var(--flow-green)' : 'var(--flow-orange)';
  }

  // Netto Cashflow Karte: Farbe nach Vorzeichen
  const netValue = document.getElementById('historyKpiNet');
  if (netValue) netValue.style.color = net >= 0 ? 'var(--flow-green)' : 'var(--flow-orange)';

  // DV-Vergleich — nur Monat/Jahr
  const dvView = String(summary?.view || '');
  const dvVisible = (dvView === 'month' || dvView === 'year')
    && kpis?.hypFullFeedInEur != null;
  const dvSection = document.getElementById('historyDvComparisonSection');
  if (dvSection) dvSection.style.display = dvVisible ? '' : 'none';

  if (dvVisible) {
    setText('historyKpiHypFullFeedIn', fmtEur(kpis.hypFullFeedInEur));
    setText('historyKpiHypSurplusFeedIn', fmtEur(kpis.hypSurplusFeedInEur));

    // DV-Mehrerlos: gruen wenn positiv, orange wenn negativ
    const dvExcessEl = document.getElementById('historyKpiDvExcess');
    if (dvExcessEl) {
      dvExcessEl.textContent = fmtEur(kpis.dvExcessEur);
      dvExcessEl.style.color = (kpis.dvExcessEur ?? 0) >= 0
        ? 'var(--flow-green)'
        : 'var(--flow-orange)';
    }

    setText('historyKpiDvCost', fmtEur(kpis.dvCostEur ?? 0));

    // Netto DV-Vorteil: gruen wenn positiv, orange wenn negativ
    const dvNetEl = document.getElementById('historyKpiDvNetAdvantage');
    if (dvNetEl) {
      dvNetEl.textContent = fmtEur(kpis.dvNetAdvantageEur);
      dvNetEl.style.color = (kpis.dvNetAdvantageEur ?? 0) >= 0
        ? 'var(--flow-green)'
        : 'var(--flow-orange)';
    }
  }

  const view = String(summary?.view || '');
  const premiumVisible = view === 'week' || view === 'month' || view === 'year';
  const displaySource = String(summary?.meta?.marketPremium?.displaySource || summary?.meta?.marketPremium?.source || '');
  let premiumScopeLabel = 'Jahresansicht';
  let marketValueLabel = 'Jahresmarktwert';
  if (view === 'month') {
    premiumScopeLabel = 'Monatsansicht';
    marketValueLabel = displaySource === 'official_annual' ? 'Jahresmarktwert' : 'Monatsmarktwert';
  } else if (view === 'week') {
    premiumScopeLabel = 'Wochenansicht';
    marketValueLabel = 'Monatsmarktwert';
  } else if (displaySource === 'configured_monthly') {
    marketValueLabel = 'Monatsmarktwert (gewichtet)';
  }
  setHidden('historyPremiumFields', !premiumVisible);
  setHidden('historyPremiumHint', true);
  setText('historyPremiumHint', '');
  setText('historyPremiumScopeLabel', premiumScopeLabel);
  setText('historyPremiumMarketValueLabel', marketValueLabel);
  setText('historyPremiumRateLabel', 'Marktprämie ct/kWh');
  if (!premiumVisible) return;
  setText(
    'historyKpiAnnualMarketValue',
    hasFiniteNumber(summary?.kpis?.periodMarketValueCtKwh ?? summary?.kpis?.annualMarketValueCtKwh)
      ? fmtCt(summary?.kpis?.periodMarketValueCtKwh ?? summary?.kpis?.annualMarketValueCtKwh)
      : 'noch nicht verfügbar'
  );
  setText(
    'historyKpiPremiumEligibleExport',
    hasFiniteNumber(summary?.kpis?.premiumEligibleExportKwh)
      ? fmtKwh(summary?.kpis?.premiumEligibleExportKwh)
      : 'noch nicht verfügbar'
  );
  setText(
    'historyKpiMarketPremium',
    hasFiniteNumber(summary?.kpis?.marketPremiumEur)
      ? fmtEur(summary?.kpis?.marketPremiumEur)
      : 'noch nicht verfügbar'
  );
  setText(
    'historyKpiMarketPremiumRate',
    hasFiniteNumber(summary?.kpis?.marketPremiumCtKwh)
      ? fmtCt(summary?.kpis?.marketPremiumCtKwh)
      : 'noch nicht verfügbar'
  );
  const premiumMeta = summary?.meta?.marketPremium || {};
  if (view === 'year' && premiumMeta?.source === 'derived_monthly_running') {
    const availableMonths = Number(premiumMeta?.availableMarketValueMonths || 0);
    const monthLabel = `${availableMonths} Monatswert${availableMonths === 1 ? '' : 'e'}`;
    setText(
      'historyPremiumHint',
      `Vorläufig aus verfügbaren Monatsmarktwerten berechnet. Monatswerte werden nachlaufend zu Beginn des Folgemonats veröffentlicht. Aktuell ${monthLabel} verfügbar.`
    );
    setHidden('historyPremiumHint', false);
  }
}

function chartBadge(item) {
  const badges = [];
  if (item?.estimated) badges.push('<span class="history-point-badge">geschätzt</span>');
  if (item?.incomplete) badges.push('<span class="history-point-badge history-point-badge-warn">offen</span>');
  return badges.join('');
}

function sourceStatusLabel(item) {
  const explicit = String(item?.sourceKind || '').trim();
  const sourceKinds = Array.isArray(item?.sourceKinds)
    ? item.sourceKinds.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  if (explicit === 'local_live') return 'lokal vorlaeufig';
  if (explicit === 'vrm_import') return 'durch VRM bestaetigt';
  if (explicit === 'mixed') return 'teils lokal, teils VRM bestaetigt';
  if (sourceKinds.includes('local_live') && sourceKinds.includes('vrm_import')) return 'teils lokal, teils VRM bestaetigt';
  if (sourceKinds.includes('vrm_import')) return 'durch VRM bestaetigt';
  if (sourceKinds.includes('local_live')) return 'lokal vorlaeufig';
  return '';
}

function sourceSummary(summary) {
  const metaSummary = summary?.meta?.sourceSummary;
  if (metaSummary && (metaSummary.localLiveSlots != null || metaSummary.vrmImportSlots != null)) {
    return {
      localLiveSlots: Number(metaSummary.localLiveSlots || 0),
      vrmImportSlots: Number(metaSummary.vrmImportSlots || 0)
    };
  }
  const slots = Array.isArray(summary?.slots) ? summary.slots : [];
  let localLiveSlots = 0;
  let vrmImportSlots = 0;
  for (const slot of slots) {
    const kinds = new Set(Array.isArray(slot?.sourceKinds) ? slot.sourceKinds : []);
    if (slot?.sourceKind === 'local_live') kinds.add('local_live');
    if (slot?.sourceKind === 'vrm_import') kinds.add('vrm_import');
    if (kinds.has('local_live')) localLiveSlots += 1;
    if (kinds.has('vrm_import')) vrmImportSlots += 1;
  }
  return {
    localLiveSlots,
    vrmImportSlots
  };
}

function dateParts(dateString) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  return { year, month, day };
}

function shiftDate(dateString, view, delta) {
  const { year, month, day } = dateParts(dateString);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (view === 'day') date.setUTCDate(date.getUTCDate() + delta);
  if (view === 'week') date.setUTCDate(date.getUTCDate() + (delta * 7));
  if (view === 'month') date.setUTCMonth(date.getUTCMonth() + delta);
  if (view === 'year') date.setUTCFullYear(date.getUTCFullYear() + delta);
  return date.toISOString().slice(0, 10);
}

function baselineTotalCostEur(item) {
  if (!item) return 0;
  if (hasFiniteNumber(item?.selfConsumptionCostEur)) return round2(Number(item.selfConsumptionCostEur));
  return actualCostEur(item);
}

function actualCostEur(item) {
  if (!item) return 0;
  return round2(importCostEur(item) + valueOf(item, 'pvCostEur') + valueOf(item, 'batteryCostEur'));
}

function importCostEur(item) {
  if (!item) return 0;
  return round2(Number(item?.gridCostEur ?? item?.importCostEur ?? 0));
}

function cashNetEur(item) {
  if (!item) return 0;
  return round2(valueOf(item, 'exportRevenueEur') - importCostEur(item));
}

function savedMoneyEur(item) {
  if (!item) return 0;
  return round2(valueOf(item, 'avoidedImportGrossEur') - valueOf(item, 'pvCostEur') - valueOf(item, 'batteryCostEur'));
}

function grossReturnEur(item) {
  if (!item) return 0;
  if (hasFiniteNumber(item?.grossReturnEur)) return round2(Number(item.grossReturnEur));
  return round2(cashNetEur(item) + savedMoneyEur(item));
}

function actualNetEur(item) {
  const explicit = Number(item?.netEur);
  if (Number.isFinite(explicit)) return round2(explicit);
  return round2(valueOf(item, 'exportRevenueEur') - actualCostEur(item));
}

function isAggregateView(view) {
  return String(view || '') !== 'day';
}

function defaultAggregateMode(view) {
  return String(view || '') === 'week' ? 'overview' : 'table';
}

function aggregateModeForView(view) {
  const normalizedView = String(view || '');
  if (!isAggregateView(normalizedView)) return null;
  if (!historyState.aggregateModeByView[normalizedView]) {
    historyState.aggregateModeByView[normalizedView] = defaultAggregateMode(normalizedView);
  }
  return historyState.aggregateModeByView[normalizedView];
}

function setAggregateMode(view, mode) {
  const normalizedView = String(view || '');
  if (!isAggregateView(normalizedView)) return;
  historyState.aggregateModeByView[normalizedView] = mode === 'table' ? 'table' : 'overview';
}

function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const [year, month, day] = String(value).split('-').map(Number);
  return { year, month, day };
}

function formatShortDate(value) {
  const parsed = parseIsoDate(value);
  if (!parsed) return String(value || '-');
  return `${String(parsed.day).padStart(2, '0')}.${String(parsed.month).padStart(2, '0')}.`;
}

function utcDateOnly(value) {
  const parsed = parseIsoDate(value);
  if (!parsed) return null;
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
}

function startOfWeekDateOnly(value) {
  const date = utcDateOnly(value);
  if (!date) return null;
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday);
  return date.toISOString().slice(0, 10);
}

const aggregateTableColumns = [
  { key: 'importKwh', label: 'Import', formatter: fmtKwh },
  { key: 'loadKwh', label: 'Verbrauch', formatter: fmtKwh },
  { key: 'pvShareKwh', label: 'Eigenverbrauch PV', formatter: fmtKwh },
  { key: 'batteryShareKwh', label: 'Eigenverbrauch Akku', formatter: fmtKwh },
  { key: 'exportKwh', label: 'Einspeisung', formatter: fmtKwh },
  { key: 'exportRevenueEur', label: 'Erlös Einspeisung', formatter: fmtEur },
  { key: 'gridCostEur', fallbackKey: 'importCostEur', label: 'Bezugskosten', formatter: fmtEur },
  { key: 'pvCostEur', label: 'PV-Kosten', formatter: fmtEur },
  { key: 'batteryCostEur', label: 'Akku-Kosten', formatter: fmtEur },
  { key: 'avoidedImportGrossEur', label: 'Vermiedene Bezugskosten', formatter: fmtEur },
  { key: 'netEur', derived: actualNetEur, label: 'Netto', formatter: fmtEur },
  { key: 'grossReturnEur', derived: grossReturnEur, label: 'Brutto-Erlös', formatter: fmtEur }
];

const aggregateMetricKeys = [
  'importKwh',
  'loadKwh',
  'pvShareKwh',
  'batteryShareKwh',
  'exportKwh',
  'exportRevenueEur',
  'gridCostEur',
  'importCostEur',
  'pvCostEur',
  'batteryCostEur',
  'avoidedImportGrossEur',
  'premiumEligibleExportKwh',
  'premiumValuedExportKwh',
  'marketPremiumCtTotal',
  'netEur',
  'estimatedSlots',
  'incompleteSlots'
];

function aggregateColumnValue(row, column) {
  if (typeof column.derived === 'function') return column.derived(row);
  if (column.fallbackKey != null) {
    return row?.[column.key] ?? row?.[column.fallbackKey] ?? 0;
  }
  return row?.[column.key] ?? 0;
}

function buildAggregateRow(label, rows) {
  const nextRow = { label };
  for (const key of aggregateMetricKeys) nextRow[key] = 0;
  for (const row of rows) {
    for (const key of aggregateMetricKeys) {
      nextRow[key] = round2(Number(nextRow[key] || 0) + Number(row?.[key] || 0));
    }
  }
  return nextRow;
}

function aggregateSummaryLabel(view) {
  if (view === 'month') return 'Gesamt Monat';
  if (view === 'year') return 'Gesamt Jahr';
  return 'Gesamt Woche';
}

function buildAggregateSummaryRow(summary) {
  const view = String(summary?.view || '');
  const kpis = summary?.kpis || {};
  return {
    label: aggregateSummaryLabel(view),
    importKwh: Number(kpis.importKwh || 0),
    loadKwh: Number(kpis.loadKwh || 0),
    pvShareKwh: Number(kpis.selfConsumptionKwh || 0) ? Number(kpis.selfConsumptionKwh || 0) - Number(kpis.importKwh || 0) - Number(kpis.batteryShareKwh || 0) : Number(kpis.pvShareKwh || 0),
    batteryShareKwh: Number(kpis.batteryShareKwh || 0),
    exportKwh: Number(kpis.exportKwh || 0),
    exportRevenueEur: Number(kpis.exportRevenueEur || 0),
    gridCostEur: Number(kpis.gridCostEur ?? kpis.importCostEur ?? 0),
    importCostEur: Number(kpis.importCostEur || kpis.gridCostEur || 0),
    pvCostEur: Number(kpis.pvCostEur || 0),
    batteryCostEur: Number(kpis.batteryCostEur || 0),
    avoidedImportGrossEur: Number(kpis.avoidedImportGrossEur || 0),
    premiumEligibleExportKwh: Number(kpis.premiumEligibleExportKwh || 0),
    premiumValuedExportKwh: Number(kpis.premiumValuedExportKwh || 0),
    marketPremiumCtTotal: Number(kpis.marketPremiumCtTotal || 0),
    netEur: Number(actualNetEur(kpis)),
    grossReturnEur: Number(grossReturnEur(kpis)),
    marketPremiumEur: hasFiniteNumber(kpis.marketPremiumEur) ? Number(kpis.marketPremiumEur) : null,
    marketPremiumCtKwh: hasFiniteNumber(kpis.marketPremiumCtKwh) ? Number(kpis.marketPremiumCtKwh) : null
  };
}

function buildAggregateDisplayRows(summary) {
  const view = String(summary?.view || '');
  const rows = Array.isArray(summary?.rows) ? summary.rows.slice() : [];
  if (!rows.length) return [];
  if (view === 'week' || view === 'year') {
    return rows.map((row) => ({
      ...row,
      label: row.label || row.key || '-'
    }));
  }
  if (view !== 'month') {
    return rows;
  }

  const groups = new Map();
  const sortedRows = rows.slice().sort((left, right) => String(left?.label || '').localeCompare(String(right?.label || '')));
  for (const row of sortedRows) {
    const rowLabel = String(row?.label || row?.key || '');
    const groupKey = startOfWeekDateOnly(rowLabel) || rowLabel;
    const group = groups.get(groupKey) || {
      key: groupKey,
      start: rowLabel,
      end: rowLabel,
      rows: []
    };
    group.rows.push(row);
    if (rowLabel < group.start) group.start = rowLabel;
    if (rowLabel > group.end) group.end = rowLabel;
    groups.set(groupKey, group);
  }

  return Array.from(groups.values())
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((group, index) => ({
      ...buildAggregateRow(`Woche ${index + 1} · ${formatShortDate(group.start)}-${formatShortDate(group.end)}`, group.rows),
      key: group.key
    }));
}

function renderAggregateSummaryTable(summary) {
  const summaryRow = buildAggregateSummaryRow(summary);
  const summaryColumns = [
    aggregateTableColumns[5],
    aggregateTableColumns[6],
    aggregateTableColumns[7],
    aggregateTableColumns[8],
    aggregateTableColumns[9],
    aggregateTableColumns[10],
    aggregateTableColumns[11]
  ];

  return `
    <table class="history-summary-table">
      <thead>
        <tr>
          <th>Zeitraum</th>
          ${summaryColumns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        <tr>
          <th>${escapeHtml(summaryRow.label)}</th>
          ${summaryColumns.map((column) => `<td>${column.formatter(aggregateColumnValue(summaryRow, column))}</td>`).join('')}
        </tr>
      </tbody>
    </table>
  `;
}

function renderAggregateTrend(items) {
  if (!Array.isArray(items) || !items.length) return '<div class="history-chart-empty">Keine Daten für diese Ansicht.</div>';
  const width = 520;
  const height = 180;
  const marginLeft = 46;
  const marginRight = 18;
  const marginTop = 12;
  const marginBottom = 30;
  const innerWidth = width - marginLeft - marginRight;
  const innerHeight = height - marginTop - marginBottom;
  const series = [
    { key: 'netEur', label: 'Netto', className: 'history-series-net', formatter: fmtEur, derived: actualNetEur },
    { key: 'importKwh', label: 'Import', className: 'history-series-import', formatter: fmtKwh },
    { key: 'exportKwh', label: 'Einspeisung', className: 'history-series-export', formatter: fmtKwh }
  ];
  const values = series.flatMap((entry) => items.map((item) => Number(typeof entry.derived === 'function' ? entry.derived(item) : item?.[entry.key] || 0)));
  const min = Math.min(0, ...(values.length ? values : [0]));
  const max = Math.max(1, ...(values.length ? values : [1]));
  const ticks = axisTickMeta(min, max, 4, (value) => Number(value).toLocaleString('de-DE', { maximumFractionDigits: 1 }));
  const xTicks = xAxisTickMeta(items, 6);

  return `
    <div class="history-aggregate-trend">
      <div class="history-chart-legend">
        ${series.map((entry) => `<span><i class="history-legend-swatch ${entry.className}"></i>${escapeHtml(entry.label)}</span>`).join('')}
      </div>
      <svg viewBox="0 0 ${width} ${height}" class="history-line-svg" aria-hidden="true">
        ${ticks.map((tick) => {
          const y = marginTop + (tick.ratio * innerHeight);
          return `
            <path class="history-grid-line" d="M${marginLeft},${y.toFixed(2)} L${(marginLeft + innerWidth).toFixed(2)},${y.toFixed(2)}" />
            <text class="history-axis-label" x="0" y="${(y + 4).toFixed(2)}">${escapeHtml(tick.label)}</text>
          `;
        }).join('')}
        <path class="history-axis-baseline" d="M${marginLeft},${(marginTop + innerHeight).toFixed(2)} L${(marginLeft + innerWidth).toFixed(2)},${(marginTop + innerHeight).toFixed(2)}" />
        ${xTicks.map((tick) => {
          const x = items.length === 1 ? marginLeft + (innerWidth / 2) : marginLeft + ((tick.index / Math.max(items.length - 1, 1)) * innerWidth);
          return `<text class="history-axis-label history-x-axis-label" x="${x.toFixed(2)}" y="${(height - 6).toFixed(2)}">${escapeHtml(tick.label)}</text>`;
        }).join('')}
        ${series.map((entry) => {
          const points = items.map((item) => Number(typeof entry.derived === 'function' ? entry.derived(item) : item?.[entry.key] || 0));
          return `<path class="history-series-line ${entry.className}" d="${linePathWithOffset(points, innerWidth, innerHeight, min, max, marginLeft, marginTop)}" />`;
        }).join('')}
      </svg>
    </div>
  `;
}

function renderAggregateBreakdownTable(summary) {
  const view = String(summary?.view || '');
  const rows = buildAggregateDisplayRows(summary);
  if (!rows.length) {
    return '<div class="history-chart-empty">Keine Daten für diese Ansicht.</div>';
  }
  const includeSummary = view === 'month' || view === 'year';
  const summaryRow = buildAggregateSummaryRow(summary);
  const displayRows = includeSummary ? [summaryRow, ...rows] : rows;

  return `
    <table class="history-aggregate-breakdown-table">
      <thead>
        <tr>
          <th>Periode</th>
          ${aggregateTableColumns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${displayRows.map((row, index) => `
          <tr class="${index === 0 && includeSummary ? 'history-aggregate-summary-row' : ''}">
            <th>${escapeHtml(row.label || '-')}</th>
            ${aggregateTableColumns.map((column) => `<td>${column.formatter(aggregateColumnValue(row, column))}</td>`).join('')}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderAggregateOverview(mountId, summary) {
  const mount = byId(mountId);
  if (!mount) return;
  const rows = buildAggregateDisplayRows(summary);
  if (!rows.length) {
    mount.innerHTML = '<div class="history-chart-empty">Keine Daten für diese Ansicht.</div>';
    return;
  }
  mount.innerHTML = `
    <div class="history-aggregate-overview">
      ${renderAggregateSummaryTable(summary)}
      ${renderAggregateTrend(rows)}
    </div>
  `;
}

function renderAggregateTable(mountId, summary) {
  const mount = byId(mountId);
  if (!mount) return;
  mount.innerHTML = renderAggregateBreakdownTable(summary);
}



function linePath(points, width, height, min, max) {
  if (!points.length) return '';
  const span = max - min || 1;
  return points.map((point, index) => {
    const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
    const y = height - (((point - min) / span) * height);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

function linePathWithOffset(points, width, height, min, max, xOffset, yOffset = 0) {
  if (!points.length) return '';
  const span = max - min || 1;
  return points.map((point, index) => {
    const x = points.length === 1 ? xOffset + (width / 2) : xOffset + (index / (points.length - 1)) * width;
    const y = yOffset + height - (((point - min) / span) * height);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

function axisTickMeta(min, max, count, formatter) {
  const span = max - min || 1;
  return Array.from({ length: count }, (_, index) => {
    const ratio = index / Math.max(count - 1, 1);
    const value = max - (span * ratio);
    return {
      label: formatter(value),
      ratio,
      value
    };
  });
}

function compactAxisLabel(label) {
  const value = String(label || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [, month, day] = value.split('-');
    return `${day}.${month}.`;
  }
  if (/^\d{4}-\d{2}$/.test(value)) {
    const [year, month] = value.split('-');
    return `${month}/${year.slice(2)}`;
  }
  if (/^\d{2}:\d{2}$/.test(value)) {
    return value;
  }
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

function selectedChartIndex(mountId, items) {
  return Math.max(0, Math.min(
    Number(historyState.chartCursorByMount[mountId] ?? (items.length - 1)),
    items.length - 1
  ));
}

function xAxisTickMeta(items, maxLabels = 6) {
  if (!Array.isArray(items) || !items.length) return [];
  const step = Math.max(1, Math.ceil(items.length / maxLabels));
  return items.map((item, index) => ({
    index,
    label: compactAxisLabel(item?.label || item?.key || '-')
  })).filter((entry, idx, list) => (
    entry.index === 0
      || entry.index === list.length - 1
      || entry.index % step === 0
  ));
}

function bindLineChartPointer(mount, mountId, items, rerender) {
  if (typeof mount.querySelector !== 'function') return;
  const hoverSurface = mount.querySelector('.history-chart-hover-surface');
  if (!hoverSurface || typeof hoverSurface.addEventListener !== 'function') return;
  const setIndexFromPointer = (event) => {
    const touch = event?.touches?.[0] || event;
    const rect = typeof hoverSurface.getBoundingClientRect === 'function'
      ? hoverSurface.getBoundingClientRect()
      : { left: 0, width: 1 };
    const widthValue = Math.max(Number(rect.width || 0), 1);
    const ratio = Math.max(0, Math.min(1, (Number(touch?.clientX || 0) - Number(rect.left || 0)) / widthValue));
    historyState.chartCursorByMount[mountId] = Math.round(ratio * Math.max(items.length - 1, 0));
    rerender();
  };
  hoverSurface.addEventListener('mousemove', setIndexFromPointer);
  hoverSurface.addEventListener('mouseenter', setIndexFromPointer);
  hoverSurface.addEventListener('touchstart', setIndexFromPointer, { passive: true });
  hoverSurface.addEventListener('touchmove', setIndexFromPointer, { passive: true });
}

function bindBarChartPointer(mount, mountId, items, rerender) {
  if (typeof mount.querySelectorAll !== 'function') return;
  const targets = mount.querySelectorAll('.history-chart-hover-surface[data-history-index]');
  if (!targets || typeof targets.forEach !== 'function') return;
  targets.forEach((target) => {
    if (typeof target.addEventListener !== 'function') return;
    const setActive = () => {
      historyState.chartCursorByMount[mountId] = Number(target.dataset.historyIndex || 0);
      rerender();
    };
    target.addEventListener('mouseenter', setActive);
    target.addEventListener('click', setActive);
    target.addEventListener('touchstart', setActive, { passive: true });
  });
}

// CSS class → color mapping for Chart.js series
const seriesColorMap = {
  'history-series-cost': '#00A8FF',
  'history-series-import': '#00A8FF',
  'history-series-market': '#00A8FF',
  'history-series-user': '#00A8FF',
  'history-series-revenue': '#39E06F',
  'history-series-export': '#39E06F',
  'history-series-net': '#A8F000',
  'history-series-load': 'rgba(191,199,210,0.92)',
  'history-series-load-gray': 'rgba(191,199,210,0.92)',
  'history-series-pv': '#f5c451',
  'history-series-pv-ac': '#ff9f43',
  'history-series-import-red': '#ff6b6b',
  'history-series-battery': '#67a5ff'
};

function renderLineChart(mountId, items, series, formatter, unitLabel, options = {}) {
  const mount = byId(mountId);
  if (!mount) return;
  if (!Array.isArray(items) || !items.length) {
    mount.innerHTML = '<div class="history-chart-empty">Keine Daten für diese Ansicht.</div>';
    return;
  }
  if (typeof Chart === 'undefined') return; // fallback: skip if Chart.js not loaded

  // Destroy previous chart
  if (historyChartInstances[mountId]) { historyChartInstances[mountId].destroy(); delete historyChartInstances[mountId]; }

  const chartHeight = Number(options.height || 220);
  const labels = items.map(item => compactAxisLabel(item?.label || '-'));
  const datasets = series.map(entry => ({
    label: entry.label,
    data: items.map(item => Number(item?.[entry.key]) || 0),
    borderColor: seriesColorMap[entry.className] || '#9ca3af',
    backgroundColor: (seriesColorMap[entry.className] || '#9ca3af') + '18',
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 4,
    fill: false,
    tension: 0.3
  }));

  mount.innerHTML = `<div style="position:relative;height:${chartHeight}px"><canvas id="${mountId}Canvas"></canvas></div>`;
  const canvas = document.getElementById(mountId + 'Canvas');
  if (!canvas) return;

  historyChartInstances[mountId] = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: { color: '#9ca3af', font: { size: 10 }, usePointStyle: true, padding: 10 }
        },
        tooltip: {
          enabled: true,
          backgroundColor: '#1a1a2eee',
          titleColor: '#e5e7eb',
          bodyColor: '#e5e7eb',
          borderColor: '#334155',
          borderWidth: 1,
          padding: 8,
          displayColors: true,
          callbacks: {
            label: (ctx) => {
              const entry = series[ctx.datasetIndex];
              const val = ctx.raw;
              const fmt = entry?.formatter || formatter;
              return `${ctx.dataset.label}: ${fmt(val)}`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#9ca3af', font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
          grid: { color: '#e5e7eb20' }
        },
        y: {
          title: { display: true, text: unitLabel, color: '#9ca3af', font: { size: 10 } },
          ticks: { color: '#9ca3af', font: { size: 9 }, callback: (v) => formatter(v) },
          grid: { color: '#e5e7eb20' },
          beginAtZero: options.min === 0,
          min: Number.isFinite(options.min) ? options.min : undefined
        }
      }
    }
  });
}

function renderDetailedDayChart(mountId, items) {
  const series = [
    { key: 'pvKwh', label: 'PV', className: 'history-series-pv', formatter: fmtKwh },
    { key: 'pvAcKwh', label: 'PV AC', className: 'history-series-pv-ac', formatter: fmtKwh },
    { key: 'importKwh', label: 'Import', className: 'history-series-import-red', formatter: fmtKwh },
    { key: 'batteryKwh', label: 'Akku', className: 'history-series-battery', formatter: fmtKwh },
    { key: 'exportKwh', label: 'Export', className: 'history-series-export', formatter: fmtKwh },
    { key: 'loadKwh', label: 'Last', className: 'history-series-load-gray', formatter: fmtKwh }
  ];
  renderLineChart(mountId, items, series, fmtKwh, 'kWh', {
    width: 580,
    height: 220,
    min: 0,
    tickCount: 5,
    detail: true,
    interactive: true,
    maxLabels: 8,
    inspectorExtras: (item) => [
      ['PV AC', item?.pvAcKwh],
      ['PV direkt', item?.solarDirectUseKwh],
      ['PV → Akku', item?.solarToBatteryKwh],
      ['PV → Netz', item?.solarToGridKwh],
      ['Netz direkt', item?.gridDirectUseKwh],
      ['Netz → Akku', item?.gridToBatteryKwh],
      ['Akku direkt', item?.batteryDirectUseKwh],
      ['Akku → Netz', item?.batteryToGridKwh]
    ]
      .filter(([, value]) => Number.isFinite(Number(value)) && Number(value) !== 0)
      .map(([label, value]) => `<span>${escapeHtml(label)} ${fmtKwh(value)}</span>`)
      .join(''),
    badgeRenderer: chartBadge
  });
}

function stackHeight(value, max) {
  if (!Number.isFinite(Number(value)) || max <= 0) return 0;
  return Math.max(12, Math.round((Number(value) / max) * 128));
}

function renderRevenueCostBars(mountId, items) {
  const mount = byId(mountId);
  if (!mount) return;
  if (!Array.isArray(items) || !items.length) {
    mount.innerHTML = '<div class="history-chart-empty">Keine Daten für diese Ansicht.</div>';
    return;
  }

  const max = Math.max(...items.flatMap((item) => [
    Number(item?.exportRevenueEur || 0),
    baselineTotalCostEur(item)
  ]), 0.01);

  mount.innerHTML = `
    <div class="history-stack-chart">
      <div class="history-chart-legend">
        <span><i class="history-legend-swatch history-bar-revenue"></i>Erlös</span>
        <span><i class="history-legend-swatch history-bar-cost"></i>Kosten</span>
      </div>
      <div class="history-bars">
        ${items.map((item) => `
          <div class="history-bar-card">
            <div class="history-stack history-stack-compare">
              <div class="history-bar history-bar-revenue" style="height:${stackHeight(item?.exportRevenueEur, max)}px"></div>
              <div class="history-bar history-bar-cost" style="height:${stackHeight(baselineTotalCostEur(item), max)}px"></div>
            </div>
            <strong>${escapeHtml(item.label || '-')}</strong>
            <span>Export ${fmtKwh(item?.exportKwh)}</span>
            <span>Erlös ${fmtEur(item?.exportRevenueEur)}</span>
            <span>Kosten ${fmtEur(baselineTotalCostEur(item))}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderCombinedPeriodBars(mountId, items) {
  const mount = byId(mountId);
  if (!mount) return;
  if (!Array.isArray(items) || !items.length) {
    mount.innerHTML = '<div class="history-chart-empty">Keine Daten für diese Ansicht.</div>';
    return;
  }

  const energyMax = Math.max(...items.flatMap((item) => [
    Number(item?.importKwh || 0),
    Number(item?.exportKwh || 0),
    Number(item?.pvShareKwh || 0),
    Number(item?.batteryShareKwh || 0)
  ]), 0.01);
  const financeMax = Math.max(...items.flatMap((item) => [
    Number(item?.exportRevenueEur || 0),
    Number(item?.gridCostEur ?? item?.importCostEur ?? 0),
    Number(item?.pvCostEur || 0),
    Number(item?.batteryCostEur || 0),
    baselineTotalCostEur(item),
    Math.abs(actualNetEur(item))
  ]), 0.01);
  const selectedIndex = selectedChartIndex(mountId, items);
  const selectedItem = items[selectedIndex] || items[0];
  const energyMetrics = [
    { key: 'importKwh', label: 'Import', formatter: fmtKwh, className: 'history-bar-grid' },
    { key: 'pvShareKwh', label: 'Eigenverbrauch PV', formatter: fmtKwh, className: 'history-bar-pv' },
    { key: 'batteryShareKwh', label: 'Eigenverbrauch Akku', formatter: fmtKwh, className: 'history-bar-battery' },
    { key: 'exportKwh', label: 'Einspeisung', formatter: fmtKwh, className: 'history-bar-export' }
  ];
  const financeMetrics = [
    { key: 'exportRevenueEur', label: 'Erlös Einspeisung', formatter: fmtEur, className: 'history-bar-revenue' },
    { key: 'gridCostEur', fallbackKey: 'importCostEur', label: 'Bezugskosten', formatter: fmtEur, className: 'history-bar-cost' },
    { key: 'pvCostEur', label: 'PV-Kosten', formatter: fmtEur, className: 'history-bar-pv' },
    { key: 'batteryCostEur', label: 'Akku-Kosten', formatter: fmtEur, className: 'history-bar-battery' }
  ];
  const renderMetricBar = (item, metric, max) => {
    const rawValue = metric.fallbackKey != null
      ? (item?.[metric.key] ?? item?.[metric.fallbackKey] ?? 0)
      : (item?.[metric.key] ?? 0);
    return `
      <div class="history-period-bar-slot" title="${escapeHtml(metric.label)} ${escapeHtml(metric.formatter(rawValue))}">
        <div class="history-period-bar-shell">
          <div class="history-bar history-bar-slim ${metric.className}" style="height:${stackHeight(rawValue, max)}px"></div>
        </div>
        <span class="history-period-bar-label">${escapeHtml(metric.label)}</span>
      </div>
    `;
  };
  const renderMetricValues = (item, metrics) => `
    <dl class="history-period-value-list">
      ${metrics.map((metric) => {
        const rawValue = metric.fallbackKey != null
          ? (item?.[metric.key] ?? item?.[metric.fallbackKey] ?? 0)
          : (item?.[metric.key] ?? 0);
        return `
          <div class="history-period-value-item">
            <dt>${escapeHtml(metric.label)}</dt>
            <dd>${metric.formatter(rawValue)}</dd>
          </div>
        `;
      }).join('')}
    </dl>
  `;

  mount.innerHTML = `
    <div class="history-stack-chart history-stack-chart-combined">
      <div class="history-chart-summary">
        <span>Vermiedene Bezugskosten ${fmtEur(selectedItem?.avoidedImportGrossEur)}</span>
        <span>Energie-Skala bis ${fmtKwh(energyMax)}</span>
        <span>Finanz-Skala bis ${fmtEur(financeMax)}</span>
      </div>
      <div class="history-period-grid">
        ${items.map((item, index) => `
          <article class="history-period-card ${index === selectedIndex ? 'is-active' : ''} history-chart-hover-surface" data-history-index="${index}" aria-hidden="true">
            <div class="history-period-header">
              <strong>${escapeHtml(item.label || '-')}</strong>
              ${chartBadge(item)}
            </div>
            <section class="history-period-bar-group">
              <div class="history-period-section-title">Energie</div>
              <div class="history-period-bars">
                ${energyMetrics.map((metric) => renderMetricBar(item, metric, energyMax)).join('')}
              </div>
              ${renderMetricValues(item, energyMetrics)}
            </section>
            <section class="history-period-bar-group">
              <div class="history-period-section-title">Finanzen</div>
              <div class="history-period-bars">
                ${financeMetrics.map((metric) => renderMetricBar(item, metric, financeMax)).join('')}
              </div>
              ${renderMetricValues(item, financeMetrics)}
            </section>
          </article>
        `).join('')}
      </div>
      <div class="history-chart-inspector">
        <strong>${escapeHtml(selectedItem?.label || '-')}</strong>
        <span>Import ${fmtKwh(selectedItem?.importKwh)}</span>
        <span>Verbrauch ${fmtKwh(selectedItem?.loadKwh)}</span>
        <span>Eigenverbrauch PV ${fmtKwh(selectedItem?.pvShareKwh)}</span>
        <span>Eigenverbrauch Akku ${fmtKwh(selectedItem?.batteryShareKwh)}</span>
        <span>Erlös Einspeisung ${fmtEur(selectedItem?.exportRevenueEur)}</span>
        <span>Vermiedene Bezugskosten ${fmtEur(selectedItem?.avoidedImportGrossEur)}</span>
        <span>Bezugskosten ${fmtEur(selectedItem?.gridCostEur ?? selectedItem?.importCostEur)}</span>
        <span>PV-Kosten ${fmtEur(selectedItem?.pvCostEur)}</span>
        <span>Akku-Kosten ${fmtEur(selectedItem?.batteryCostEur)}</span>
        <span class="history-inspector-emphasis">Netto ${fmtEur(actualNetEur(selectedItem))}</span>
        ${chartBadge(selectedItem)}
      </div>
    </div>
  `;

  bindBarChartPointer(mount, mountId, items, () => renderCombinedPeriodBars(mountId, items));
}

function renderSolarSummary(mountId, summary) {
  const mount = byId(mountId);
  if (!mount) return;
  const solar = summary?.meta?.solarMarketValue;
  if (!solar) {
    mount.innerHTML = '<div class="history-chart-empty">Kein Marktwert Solar für diesen Zeitraum verfügbar.</div>';
    return;
  }
  mount.innerHTML = `
    <div class="history-solar-summary">
      <div class="history-solar-summary-card">
        <strong>Jahres-Marktwert Solar</strong>
        <span>${fmtCt(solar.annualCtKwh)}</span>
      </div>
      <div class="history-solar-summary-card">
        <strong>Ausgleich auf Einspeisung</strong>
        <span>${fmtEur(summary?.kpis?.solarCompensationEur)}</span>
      </div>
      <div class="history-solar-summary-card">
        <strong>Status</strong>
        <span>${solar.source === 'official_annual' ? 'offiziell' : 'vorlaeufig berechnet'}</span>
      </div>
    </div>
  `;
}

function renderPriceList(mountId, items) {
  const mount = byId(mountId);
  if (!mount) return;
  mount.innerHTML = `
    <div class="history-price-list">
      ${items.map((item) => `
        <div class="history-price-row">
          <strong>${escapeHtml(item.label || '-')}</strong>
          <span>Marktpreis ${fmtCt(item.marketPriceCtKwh)}</span>
          <span>Bezug ${fmtCt(item.userImportPriceCtKwh)}</span>
          <span>${item?.estimated || item?.incomplete ? (item.incomplete ? 'offen' : 'geschätzt') : 'gemessen'}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderAggregatePriceHint(mountId) {
  const mount = byId(mountId);
  if (!mount) return;
  mount.innerHTML = '<div class="history-chart-empty">Preisvergleich nur in der Tagesansicht. In aggregierten Ansichten liegt der Fokus auf dem kombinierten Finanzchart.</div>';
}

function renderCharts(summary) {
  const charts = summary?.charts || {};
  const dayEnergyLines = Array.isArray(charts.dayEnergyLines) ? charts.dayEnergyLines : [];
  const dayFinancialLines = Array.isArray(charts.dayFinancialLines) ? charts.dayFinancialLines : [];
  const dayPriceLines = Array.isArray(charts.dayPriceLines) ? charts.dayPriceLines : [];
  const periodCombinedBars = Array.isArray(charts.periodCombinedBars) ? charts.periodCombinedBars : [];
  const view = String(summary?.view || '');

  if (view === 'day') {
    renderLineChart('historyFinancialChart', dayFinancialLines.map((item) => ({
      ...item,
      actualCostEur: baselineTotalCostEur(item),
      actualNetEur: actualNetEur(item)
    })), [
      { key: 'actualCostEur', label: 'Kosten', className: 'history-series-cost' },
      { key: 'exportRevenueEur', label: 'Erlöse', className: 'history-series-revenue' },
      { key: 'actualNetEur', label: 'Netto', className: 'history-series-net' }
    ], fmtEur, 'EUR');
    renderDetailedDayChart('historyEnergyChart', dayEnergyLines);
    renderLineChart('historyPriceChart', dayPriceLines, [
      { key: 'marketPriceCtKwh', label: 'Marktpreis', className: 'history-series-market' },
      { key: 'userImportPriceCtKwh', label: 'Bezugspreis', className: 'history-series-user' }
    ], fmtCt, 'ct/kWh');
    setHtml('historyPriceList', '');
    setHtml('historyAggregatePriceHint', '');
    setHtml('historySolarSummary', '');
    return;
  }

  if (aggregateModeForView(view) === 'table') {
    renderAggregateTable('historyFinancialChart', summary);
  } else {
    renderAggregateOverview('historyFinancialChart', summary);
  }
  renderCombinedPeriodBars('historyEnergyChart', periodCombinedBars);
  setHtml('historyPriceChart', '');
  setHtml('historyPriceList', '');
  renderAggregatePriceHint('historyAggregatePriceHint');
  if (view === 'year') {
    renderSolarSummary('historySolarSummary', summary);
    return;
  }
  setHtml('historySolarSummary', '');
}

function renderRows(summary) {
  const rowsMount = byId('historyRows');
  if (!rowsMount) return;
  const rows = Array.isArray(summary?.rows) ? summary.rows : [];
  const includeSolar = String(summary?.view || '') === 'year';

  rowsMount.innerHTML = `
    <table class="history-data-table">
      <thead>
        <tr>
          <th>Periode</th>
          <th>Import</th>
          <th>Verbrauch</th>
          <th>PV erzeugt</th>
          <th>PV AC</th>
          <th>PV direkt</th>
          <th>PV → Akku</th>
          <th>PV → Netz</th>
          <th>Netz direkt</th>
          <th>Netz → Akku</th>
          <th>Akku direkt</th>
          <th>Akku → Netz</th>
          <th>Akku geladen</th>
          <th>Akku entladen</th>
          <th>Eigenverbrauch</th>
          <th>Eigenverbrauch Netz</th>
          <th>Eigenverbrauch PV</th>
          <th>Eigenverbrauch Akku</th>
          <th>Export</th>
          <th>Netzkosten</th>
          <th>PV-Kosten</th>
          <th>Akku-Kosten</th>
          <th>Vermiedener Bezug</th>
          <th>Erlös Einspeisung</th>
          <th>Kosten</th>
          <th>Netto</th>
          <th>Brutto-Erlös</th>
          ${includeSolar ? '<th>Marktwert Solar</th><th>Solar-Ausgleich</th>' : ''}
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td>${escapeHtml(row.label || row.key || '-')}</td>
            <td>${fmtKwh(row.importKwh)}</td>
            <td>${fmtKwh(row.loadKwh)}</td>
            <td>${fmtKwh(row.pvKwh)}</td>
            <td>${fmtKwh(row.pvAcKwh)}</td>
            <td>${fmtKwh(row.solarDirectUseKwh)}</td>
            <td>${fmtKwh(row.solarToBatteryKwh)}</td>
            <td>${fmtKwh(row.solarToGridKwh)}</td>
            <td>${fmtKwh(row.gridDirectUseKwh)}</td>
            <td>${fmtKwh(row.gridToBatteryKwh)}</td>
            <td>${fmtKwh(row.batteryDirectUseKwh)}</td>
            <td>${fmtKwh(row.batteryToGridKwh)}</td>
            <td>${fmtKwh(row.batteryChargeKwh)}</td>
            <td>${fmtKwh(row.batteryDischargeKwh)}</td>
            <td>${fmtKwh(row.selfConsumptionKwh)}</td>
            <td>${fmtKwh(row.gridShareKwh)}</td>
            <td>${fmtKwh(row.pvShareKwh)}</td>
            <td>${fmtKwh(row.batteryShareKwh)}</td>
            <td>${fmtKwh(row.exportKwh)}</td>
            <td>${fmtEur(row.gridCostEur ?? row.importCostEur)}</td>
            <td>${fmtEur(row.pvCostEur)}</td>
            <td>${fmtEur(row.batteryCostEur)}</td>
            <td>${fmtEur(row.avoidedImportGrossEur)}</td>
            <td>${fmtEur(row.exportRevenueEur)}</td>
            <td>${fmtEur(baselineTotalCostEur(row))}</td>
            <td>${fmtEur(actualNetEur(row))}</td>
            <td>${fmtEur(grossReturnEur(row))}</td>
            ${includeSolar ? `<td>${fmtCt(row.solarMarketValueCtKwh)}</td><td>${fmtEur(row.solarCompensationEur)}</td>` : ''}
            <td>${[
              sourceStatusLabel(row),
              row.incompleteSlots ? `${row.incompleteSlots} offen` : 'vollstaendig',
              row.estimatedSlots ? `${row.estimatedSlots} geschätzt` : ''
            ].filter(Boolean).join(' · ')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderLayout(summary) {
  const view = String(summary?.view || '');
  const isDayView = view === 'day';
  const chartGrid = byId('historyChartGrid');
  const financialPanel = byId('historyFinancialPanel');
  const energyPanel = byId('historyEnergyPanel');
  const pricePanel = byId('historyPricePanel');
  const aggregateMode = byId('historyAggregateMode');
  const overviewButton = byId('historyAggregateOverviewBtn');
  const tableButton = byId('historyAggregateTableBtn');
  if (chartGrid) {
    chartGrid.className = `history-chart-grid reveal ${isDayView ? 'history-chart-grid-day' : 'history-chart-grid-aggregated'}`;
  }
  if (financialPanel) {
    financialPanel.hidden = false;
    financialPanel.className = `panel history-chart-panel ${isDayView ? '' : 'history-chart-panel-wide'}`.trim();
  }
  if (energyPanel) energyPanel.hidden = !isDayView;
  if (pricePanel) pricePanel.hidden = !isDayView;
  if (aggregateMode) {
    aggregateMode.hidden = isDayView;
    aggregateMode.className = `history-aggregate-mode ${isDayView ? '' : 'is-visible'}`.trim();
  }
  if (overviewButton) {
    const isOverview = aggregateModeForView(view) === 'overview';
    overviewButton.className = `btn btn-secondary btn-inline history-aggregate-mode-btn ${isOverview ? 'is-active' : ''}`.trim();
    overviewButton.ariaPressed = isOverview ? 'true' : 'false';
  }
  if (tableButton) {
    const isTable = aggregateModeForView(view) === 'table';
    tableButton.className = `btn btn-secondary btn-inline history-aggregate-mode-btn ${isTable ? 'is-active' : ''}`.trim();
    tableButton.ariaPressed = isTable ? 'true' : 'false';
  }
}

function bindHistoryToggle(id, handler) {
  const element = byId(id);
  if (!element || element.__historyBound) return;
  element.addEventListener('click', handler);
  element.__historyBound = true;
}

function renderDetailsSection() {
  const toggle = byId('historyDetailsToggle');
  const content = byId('historyDetailsContent');
  if (toggle) {
    toggle.textContent = historyState.detailsExpanded ? 'Details ausblenden' : 'Details anzeigen';
    toggle.ariaExpanded = historyState.detailsExpanded ? 'true' : 'false';
  }
  if (content) content.hidden = !historyState.detailsExpanded;
}

function slotLabel(count, singular) {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function renderSummaryStatus(summary) {
  const unresolved = summary?.meta?.unresolved || {};
  const warningCount = Number(unresolved.incompleteSlots || 0);
  const estimatedCount = Number(unresolved.estimatedSlots || 0);
  const sources = sourceSummary(summary);
  const summaryParts = [];
  if (warningCount > 0) summaryParts.push(`${slotLabel(warningCount, 'Slot')} unvollständig`);
  if (estimatedCount > 0) summaryParts.push(`${slotLabel(estimatedCount, 'Slot')} geschätzt`);
  setBanner(summaryParts.length ? `${summaryParts.join(', ')}.` : 'Historie geladen.', warningCount ? 'warn' : 'success');

  const infoParts = [];
  if (sources.localLiveSlots > 0) infoParts.push(`<span>${sources.localLiveSlots} lokal vorlaeufig</span>`);
  if (sources.vrmImportSlots > 0) infoParts.push(`<span>${sources.vrmImportSlots} durch VRM bestaetigt</span>`);
  if (Number(unresolved.missingImportPriceSlots || 0) > 0) {
    infoParts.push(`<span>${unresolved.missingImportPriceSlots} ohne Bezugspreis</span>`);
  }
  if (Number(unresolved.missingMarketPriceSlots || 0) > 0) {
    infoParts.push(`<span>${unresolved.missingMarketPriceSlots} ohne Marktpreis</span>`);
  }
  historyState.statusInfoExpanded = false;
  setStatusInfo(infoParts.join(''));
}

function renderSummary(summary) {
  historyState.lastSummary = summary;
  historyState.detailsExpanded = false;
  renderKpis(summary);
  renderLayout(summary);
  renderCharts(summary);
  renderRows(summary);
  renderDetailsSection();
  renderSummaryStatus(summary);
  const versionLabel = summary?.app?.versionLabel ? ` · ${summary.app.versionLabel}` : '';
  setText('historyMeta', `${String(summary?.view || '').toUpperCase()} · ${summary?.date || currentDateValue()}${versionLabel}`);
  bindHistoryToggle('historyDetailsToggle', () => {
    historyState.detailsExpanded = !historyState.detailsExpanded;
    renderDetailsSection();
  });
  bindHistoryToggle('historyStatusInfoToggle', () => {
    historyState.statusInfoExpanded = !historyState.statusInfoExpanded;
    renderStatusInfo();
  });
  bindHistoryToggle('historyAggregateOverviewBtn', () => {
    const currentView = String(historyState.lastSummary?.view || '');
    if (!isAggregateView(currentView)) return;
    setAggregateMode(currentView, 'overview');
    renderSummary(historyState.lastSummary);
  });
  bindHistoryToggle('historyAggregateTableBtn', () => {
    const currentView = String(historyState.lastSummary?.view || '');
    if (!isAggregateView(currentView)) return;
    setAggregateMode(currentView, 'table');
    renderSummary(historyState.lastSummary);
  });
}

async function loadHistorySummary() {
  const view = byId('historyView')?.value || 'day';
  const date = byId('historyDate')?.value || currentDateValue();
  historyState.loading = true;
  setBanner('Historie wird geladen...');
  try {
    const response = await apiFetch(`/api/history/summary?view=${encodeURIComponent(view)}&date=${encodeURIComponent(date)}`);
    const payload = await response.json();
    if (!response.ok) {
      setBanner(`Historie konnte nicht geladen werden: ${payload.error || response.status}`, 'error');
      return;
    }
    renderSummary(payload);
  } catch (error) {
    setBanner(`Historie konnte nicht geladen werden: ${error.message}`, 'error');
  } finally {
    historyState.loading = false;
  }
}

async function triggerBackfill() {
  historyState.backfillBusy = true;
  renderBackfillButtonState();
  setBanner('Preis-Backfill läuft...', 'warn');
  try {
    const response = await apiFetch('/api/history/backfill/prices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        view: byId('historyView')?.value || 'day',
        date: byId('historyDate')?.value || currentDateValue()
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      setBanner(`Preis-Backfill fehlgeschlagen: ${payload.error || response.status}`, 'error');
      return;
    }
    await loadHistorySummary();
    if (payload.partial) {
      setBanner(`Preis-Backfill teilweise abgeschlossen: ${payload.importedRows} Preise importiert, offen: ${(payload.openDays || []).join(', ') || '-'}.`, 'warn');
      return;
    }
    setBanner(`Preis-Backfill abgeschlossen: ${payload.importedRows} Preise importiert.`, 'success');
  } catch (error) {
    setBanner(`Preis-Backfill fehlgeschlagen: ${error.message}`, 'error');
  } finally {
    historyState.backfillBusy = false;
    renderBackfillButtonState();
  }
}

function stepCurrentRange(delta) {
  const view = byId('historyView');
  const date = byId('historyDate');
  if (!view || !date) return;
  date.value = shiftDate(date.value || currentDateValue(), view.value || 'day', delta);
  loadHistorySummary().catch((error) => setBanner(`Historie konnte nicht geladen werden: ${error.message}`, 'error'));
}

function bindHistoryControls() {
  const view = byId('historyView');
  const date = byId('historyDate');
  const backfill = byId('historyBackfillBtn');
  const prev = byId('historyPrevBtn');
  const next = byId('historyNextBtn');
  if (view) view.addEventListener('change', loadHistorySummary);
  if (date) date.addEventListener('change', loadHistorySummary);
  if (backfill) backfill.addEventListener('click', triggerBackfill);
  if (prev) prev.addEventListener('click', () => stepCurrentRange(-1));
  if (next) next.addEventListener('click', () => stepCurrentRange(1));
}

function initHistoryPage() {
  const date = byId('historyDate');
  if (date && !date.value) date.value = currentDateValue();
  renderBackfillButtonState();
  bindHistoryControls();
  // Marktwert toggle on Vermiedene Kosten card
  const marketToggle = byId('historyMarketToggle');
  if (marketToggle) {
    let marketMode = false;
    marketToggle.addEventListener('click', function() {
      marketMode = !marketMode;
      const defPanel = byId('historyAvoidedDefault');
      const mktPanel = byId('historyAvoidedMarket');
      const label = byId('historyAvoidedLabel');
      if (defPanel) defPanel.hidden = marketMode;
      if (mktPanel) mktPanel.hidden = !marketMode;
      if (label) label.textContent = marketMode ? 'Vermiedene Kosten (Marktwert)' : 'Vermiedene Kosten';
      marketToggle.textContent = marketMode ? 'Bezugspreis' : 'Marktwert';
      marketToggle.style.opacity = marketMode ? '1' : '0.6';
      // Update Vermiedene Kosten + Gesamtbilanz
      const c = window._historyKpiCache;
      if (c) {
        const avoidedVal = marketMode ? round2(c.avoided - c.oppCost) : c.avoided;
        const savedMoney = round2(avoidedVal - c.pvCost - c.batCost);
        const adjustedGross = round2(c.net + savedMoney);
        setText('historyKpiAvoided', fmtEur(avoidedVal));
        setText('historyKpiBilanzAvoided', fmtEur(avoidedVal));
        setText('historyKpiGrossReturn', fmtEur(adjustedGross));
        // Update Gesamtbilanz accent color
        const bilanzCard = byId('historyKpiBilanzCard');
        if (bilanzCard) {
          const pos = adjustedGross >= 0;
          bilanzCard.dataset.accent = pos ? 'green' : 'orange';
          const bv = byId('historyKpiGrossReturn');
          if (bv) bv.style.color = pos ? 'var(--flow-green)' : 'var(--flow-orange)';
          const bk = bilanzCard.querySelector('.config-group-kicker');
          if (bk) bk.style.color = pos ? 'var(--flow-green)' : 'var(--flow-orange)';
        }
      }
    });
  }
  loadHistorySummary().catch((error) => setBanner(`Historie konnte nicht initialisiert werden: ${error.message}`, 'error'));
}

const historyHelpers = {
  fmtCt,
  fmtEur,
  fmtKwh,
  renderBackfillButtonState,
  renderRows,
  renderSummary,
  historyState
};

if (typeof globalThis !== 'undefined') {
  globalThis.DVhubHistoryPage = historyHelpers;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__DVHUB_HISTORY_TEST__) {
  initHistoryPage();
}
