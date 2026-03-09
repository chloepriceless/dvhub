const common = window.DVhubCommon || {};
const { apiFetch } = common;

const historyState = {
  loading: false,
  backfillBusy: false,
  lastSummary: null,
  chartCursorByMount: {},
  opportunityBlendPct: 0
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

function valueOf(item, key) {
  return Number(item?.[key] || 0);
}

function setBanner(text, kind = 'info') {
  const banner = byId('historyBanner');
  if (!banner) return;
  banner.textContent = text;
  banner.className = `status-banner ${kind}`;
}

function round2(value) {
  const numeric = Number(value || 0);
  const sign = numeric < 0 ? -1 : 1;
  return sign * (Math.round((Math.abs(numeric) + Number.EPSILON) * 100) / 100);
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
  setText('historyKpiCost', fmtEur(blendedCostEur(summary?.kpis)));
  setText('historyKpiRevenue', fmtEur(summary?.kpis?.exportRevenueEur));
  setText('historyKpiNet', fmtEur(blendedNetEur(summary?.kpis)));
  setText('historyKpiImport', fmtKwh(summary?.kpis?.importKwh));
  setText('historyKpiExport', fmtKwh(summary?.kpis?.exportKwh));
}

function chartBadge(item) {
  const badges = [];
  if (item?.estimated) badges.push('<span class="history-point-badge">geschätzt</span>');
  if (item?.incomplete) badges.push('<span class="history-point-badge history-point-badge-warn">offen</span>');
  return badges.join('');
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

function opportunityBlendFactor() {
  return Math.max(0, Math.min(100, Number(historyState.opportunityBlendPct || 0))) / 100;
}

function blendedCostEur(item) {
  if (!item) return 0;
  const gridCost = valueOf(item, 'gridCostEur') || valueOf(item, 'importCostEur');
  const localBaseCost = valueOf(item, 'pvCostEur') + valueOf(item, 'batteryCostEur');
  const opportunityCost = Number.isFinite(Number(item?.opportunityCostEur))
    ? Number(item.opportunityCostEur)
    : localBaseCost;
  return round2(gridCost + localBaseCost + ((opportunityCost - localBaseCost) * opportunityBlendFactor()));
}

function blendedNetEur(item) {
  return round2(valueOf(item, 'exportRevenueEur') - blendedCostEur(item));
}

function updateOpportunityLabel() {
  setText('historyOpportunityLabel', `Vergleich Marktwert ${Math.round(Number(historyState.opportunityBlendPct || 0))} %`);
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

function linePathWithOffset(points, width, height, min, max, xOffset) {
  if (!points.length) return '';
  const span = max - min || 1;
  return points.map((point, index) => {
    const x = points.length === 1 ? xOffset + (width / 2) : xOffset + (index / (points.length - 1)) * width;
    const y = height - (((point - min) / span) * height);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

function axisTicks(min, max, count, formatter) {
  const span = max - min || 1;
  return Array.from({ length: count }, (_, index) => {
    const ratio = index / Math.max(count - 1, 1);
    const value = max - (span * ratio);
    return formatter(value);
  });
}

function renderLineChart(mountId, items, series, formatter, unitLabel) {
  const mount = byId(mountId);
  if (!mount) return;
  if (!Array.isArray(items) || !items.length) {
    mount.innerHTML = '<div class="history-chart-empty">Keine Daten fuer diese Ansicht.</div>';
    return;
  }

  const width = 420;
  const height = 180;
  const values = series.flatMap((entry) => items.map((item) => Number(item?.[entry.key])))
    .filter((value) => Number.isFinite(value));
  const min = Math.min(0, ...(values.length ? values : [0]));
  const max = Math.max(...(values.length ? values : [1]), 1);
  const ticks = axisTicks(min, max, 4, formatter);

  mount.innerHTML = `
    <div class="history-line-chart">
      <div class="history-chart-legend">
        ${series.map((entry) => `<span><i class="history-legend-swatch ${entry.className}"></i>${escapeHtml(entry.label)}</span>`).join('')}
      </div>
      <div class="history-axis-caption">${escapeHtml(unitLabel)}</div>
      <svg viewBox="0 0 ${width} ${height}" class="history-line-svg" aria-hidden="true">
        ${ticks.map((label, index) => {
          const y = (index / Math.max(ticks.length - 1, 1)) * (height - 24) + 8;
          return `
            <path class="history-grid-line" d="M42,${y.toFixed(2)} L${width},${y.toFixed(2)}" />
            <text class="history-axis-label" x="0" y="${(y + 4).toFixed(2)}">${escapeHtml(label)}</text>
          `;
        }).join('')}
        ${series.map((entry) => {
          const points = items.map((item) => Number(item?.[entry.key]));
          return `<path class="history-series-line ${entry.className}" d="${linePathWithOffset(points, width - 52, height - 24, min, max, 42)}" />`;
        }).join('')}
      </svg>
    </div>
  `;
}

function yFor(value, min, max, height) {
  const span = max - min || 1;
  return height - (((value - min) / span) * height);
}

function renderDetailedDayChart(mountId, items) {
  const mount = byId(mountId);
  if (!mount) return;
  if (!Array.isArray(items) || !items.length) {
    mount.innerHTML = '<div class="history-chart-empty">Keine Daten fuer diese Ansicht.</div>';
    return;
  }

  const series = [
    { key: 'pvKwh', label: 'PV', className: 'history-series-pv', formatter: fmtKwh },
    { key: 'importKwh', label: 'Import', className: 'history-series-import-red', formatter: fmtKwh },
    { key: 'batteryKwh', label: 'Akku', className: 'history-series-battery', formatter: fmtKwh },
    { key: 'exportKwh', label: 'Export', className: 'history-series-export', formatter: fmtKwh },
    { key: 'loadKwh', label: 'Last', className: 'history-series-load-gray', formatter: fmtKwh }
  ];
  const width = 580;
  const height = 220;
  const values = series.flatMap((entry) => items.map((item) => Number(item?.[entry.key])))
    .filter((value) => Number.isFinite(value));
  const min = 0;
  const max = Math.max(...(values.length ? values : [1]), 1);
  const selectedIndex = Math.min(
    Number(historyState.chartCursorByMount[mountId] ?? (items.length - 1)),
    items.length - 1
  );
  const selectedItem = items[selectedIndex] || items[0];
  const ticks = axisTicks(min, max, 5, fmtKwh);

  mount.innerHTML = `
    <div class="history-line-chart history-line-chart-detail">
      <div class="history-chart-legend">
        ${series.map((entry) => `<span><i class="history-legend-swatch ${entry.className}"></i>${escapeHtml(entry.label)}</span>`).join('')}
      </div>
      <div class="history-axis-caption">kWh</div>
      <div class="history-chart-interaction">
        <svg viewBox="0 0 ${width} ${height}" class="history-line-svg history-line-svg-detail" aria-hidden="true">
          ${ticks.map((label, index) => {
            const y = (index / Math.max(ticks.length - 1, 1)) * (height - 32) + 10;
            return `
              <path class="history-grid-line" d="M48,${y.toFixed(2)} L${width},${y.toFixed(2)}" />
              <text class="history-axis-label" x="0" y="${(y + 4).toFixed(2)}">${escapeHtml(label)}</text>
            `;
          }).join('')}
          ${series.map((entry) => {
            const points = items.map((item) => Number(item?.[entry.key]));
            return `<path class="history-series-line ${entry.className}" d="${points.map((point, index) => {
              const x = items.length === 1 ? (width + 48) / 2 : 48 + (index / (items.length - 1)) * (width - 48);
              const y = yFor(point, min, max, height - 32) + 10;
              return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
            }).join(' ')}" />`;
          }).join('')}
          <path class="history-cursor-line" d="M${(48 + ((items.length === 1 ? 0 : selectedIndex / Math.max(items.length - 1, 1)) * (width - 48))).toFixed(2)},10 L${(48 + ((items.length === 1 ? 0 : selectedIndex / Math.max(items.length - 1, 1)) * (width - 48))).toFixed(2)},${height - 22}" />
        </svg>
        <div class="history-chart-hover-surface" data-history-mount="${escapeHtml(mountId)}" aria-hidden="true"></div>
      </div>
      <div class="history-chart-inspector">
        <strong>${escapeHtml(selectedItem?.label || '-')}</strong>
        ${series.map((entry) => `<span>${escapeHtml(entry.label)} ${entry.formatter(selectedItem?.[entry.key])}</span>`).join('')}
        ${chartBadge(selectedItem)}
      </div>
    </div>
  `;

  if (typeof mount.querySelector !== 'function') return;
  const hoverSurface = mount.querySelector('.history-chart-hover-surface');
  if (!hoverSurface || typeof hoverSurface.addEventListener !== 'function') return;
  const setIndexFromPointer = (event) => {
    const rect = typeof hoverSurface.getBoundingClientRect === 'function'
      ? hoverSurface.getBoundingClientRect()
      : { left: 0, width: 1 };
    const widthValue = Math.max(Number(rect.width || 0), 1);
    const ratio = Math.max(0, Math.min(1, (Number(event?.clientX || 0) - Number(rect.left || 0)) / widthValue));
    historyState.chartCursorByMount[mountId] = Math.round(ratio * Math.max(items.length - 1, 0));
    renderDetailedDayChart(mountId, items);
  };
  hoverSurface.addEventListener('mousemove', setIndexFromPointer);
  hoverSurface.addEventListener('mouseenter', setIndexFromPointer);
}

function stackHeight(value, max) {
  if (!Number.isFinite(Number(value)) || max <= 0) return 0;
  return Math.max(12, Math.round((Number(value) / max) * 128));
}

function renderRevenueCostBars(mountId, items) {
  const mount = byId(mountId);
  if (!mount) return;
  if (!Array.isArray(items) || !items.length) {
    mount.innerHTML = '<div class="history-chart-empty">Keine Daten fuer diese Ansicht.</div>';
    return;
  }

  const max = Math.max(...items.flatMap((item) => [
    Number(item?.exportRevenueEur || 0),
    Number(item?.selfConsumptionCostEur || 0)
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
              <div class="history-bar history-bar-cost" style="height:${stackHeight(item?.selfConsumptionCostEur, max)}px"></div>
            </div>
            <strong>${escapeHtml(item.label || '-')}</strong>
            <span>Export ${fmtKwh(item?.exportKwh)}</span>
            <span>Erlös ${fmtEur(item?.exportRevenueEur)}</span>
            <span>Kosten ${fmtEur(item?.selfConsumptionCostEur)}</span>
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
    mount.innerHTML = '<div class="history-chart-empty">Keine Daten fuer diese Ansicht.</div>';
    return;
  }

  const energyMax = Math.max(...items.flatMap((item) => [
    Number(item?.importKwh || 0),
    Number(item?.exportKwh || 0),
    Number(item?.loadKwh || 0),
    Number(item?.pvShareKwh || 0),
    Number(item?.batteryShareKwh || 0)
  ]), 0.01);
  const financeMax = Math.max(...items.flatMap((item) => [
    Number(item?.exportRevenueEur || 0),
    blendedCostEur(item)
  ]), 0.01);

  mount.innerHTML = `
    <div class="history-stack-chart history-stack-chart-combined">
      <div class="history-chart-legend">
        <span><i class="history-legend-swatch history-bar-revenue"></i>Erlös</span>
        <span><i class="history-legend-swatch history-bar-cost"></i>Kosten</span>
        <span><i class="history-legend-swatch history-bar-grid"></i>Import</span>
        <span><i class="history-legend-swatch history-bar-pv"></i>Eigenverbrauch PV</span>
        <span><i class="history-legend-swatch history-bar-battery"></i>Eigenverbrauch Akku</span>
      </div>
      <div class="history-bars history-bars-combined">
        ${items.map((item) => `
          <div class="history-bar-card history-bar-card-combined">
            <div class="history-stack history-stack-energy">
              <div class="history-bar history-bar-grid" style="height:${stackHeight(item?.importKwh, energyMax)}px"></div>
              <div class="history-bar history-bar-pv" style="height:${stackHeight(item?.pvShareKwh, energyMax)}px"></div>
              <div class="history-bar history-bar-battery" style="height:${stackHeight(item?.batteryShareKwh, energyMax)}px"></div>
              <div class="history-bar history-bar-export" style="height:${stackHeight(item?.exportKwh, energyMax)}px"></div>
            </div>
            <div class="history-stack history-stack-finance">
              <div class="history-bar history-bar-revenue" style="height:${stackHeight(item?.exportRevenueEur, financeMax)}px"></div>
              <div class="history-bar history-bar-cost" style="height:${stackHeight(blendedCostEur(item), financeMax)}px"></div>
            </div>
            <strong>${escapeHtml(item.label || '-')}</strong>
            <span>Import ${fmtKwh(item?.importKwh)}</span>
            <span>Verbrauch ${fmtKwh(item?.loadKwh)}</span>
            <span>Eigenverbrauch PV ${fmtKwh(item?.pvShareKwh)}</span>
            <span>Eigenverbrauch Akku ${fmtKwh(item?.batteryShareKwh)}</span>
            <span>Erlös ${fmtEur(item?.exportRevenueEur)}</span>
            <span>Kosten ${fmtEur(blendedCostEur(item))}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderExportBars(mountId, items) {
  const mount = byId(mountId);
  if (!mount) return;
  if (!Array.isArray(items) || !items.length) {
    mount.innerHTML = '<div class="history-chart-empty">Keine Daten fuer diese Ansicht.</div>';
    return;
  }
  const max = Math.max(...items.map((item) => Number(item?.exportKwh || 0)), 0.01);
  mount.innerHTML = `
    <div class="history-stack-chart">
      <div class="history-chart-legend">
        <span><i class="history-legend-swatch history-bar-export"></i>Export</span>
      </div>
      <div class="history-bars">
        ${items.map((item) => `
          <div class="history-bar-card">
            <div class="history-stack">
              <div class="history-bar history-bar-export" style="height:${stackHeight(item?.exportKwh, max)}px"></div>
            </div>
            <strong>${fmtKwh(item?.exportKwh)}</strong>
            <span>${escapeHtml(item.label || '-')}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderSolarSummary(mountId, summary) {
  const mount = byId(mountId);
  if (!mount) return;
  const solar = summary?.meta?.solarMarketValue;
  if (!solar) {
    mount.innerHTML = '<div class="history-chart-empty">Kein Marktwert Solar fuer diesen Zeitraum verfuegbar.</div>';
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

function renderCharts(summary) {
  const charts = summary?.charts || {};
  const dayEnergyLines = Array.isArray(charts.dayEnergyLines) ? charts.dayEnergyLines : [];
  const dayFinancialLines = Array.isArray(charts.dayFinancialLines) ? charts.dayFinancialLines : [];
  const dayPriceLines = Array.isArray(charts.dayPriceLines) ? charts.dayPriceLines : [];
  const periodFinancialBars = Array.isArray(charts.periodFinancialBars) ? charts.periodFinancialBars : [];
  const periodCombinedBars = Array.isArray(charts.periodCombinedBars) ? charts.periodCombinedBars : [];
  const periodEnergyBars = Array.isArray(charts.periodEnergyBars) ? charts.periodEnergyBars : [];

  if (String(summary?.view || '') === 'day') {
    renderLineChart('historyFinancialChart', dayFinancialLines.map((item) => ({
      ...item,
      blendedCostEur: blendedCostEur(item),
      blendedNetEur: blendedNetEur(item)
    })), [
      { key: 'blendedCostEur', label: 'Kosten', className: 'history-series-cost' },
      { key: 'exportRevenueEur', label: 'Erloese', className: 'history-series-revenue' },
      { key: 'blendedNetEur', label: 'Netto', className: 'history-series-net' }
    ], fmtEur, 'EUR');
    renderDetailedDayChart('historyEnergyChart', dayEnergyLines);
    renderLineChart('historyPriceChart', dayPriceLines, [
      { key: 'marketPriceCtKwh', label: 'Marktpreis', className: 'history-series-market' },
      { key: 'userImportPriceCtKwh', label: 'Bezugspreis', className: 'history-series-user' }
    ], fmtCt, 'ct/kWh');
    return;
  }

  renderCombinedPeriodBars('historyFinancialChart', periodCombinedBars.length ? periodCombinedBars : periodFinancialBars);
  const energyMount = byId('historyEnergyChart');
  if (energyMount) {
    energyMount.innerHTML = '<div class="history-chart-empty">Energie- und Finanzbalken sind in der linken Anzeige zusammengefuehrt.</div>';
  }

  if (String(summary?.view || '') === 'year') {
    renderSolarSummary('historyPriceChart', summary);
    return;
  }

    renderPriceList('historyPriceChart', (summary?.rows || []).map((row) => ({
      label: row.label,
      marketPriceCtKwh: row.marketPriceWeightedCtKwh,
      userImportPriceCtKwh: row.userImportPriceWeightedCtKwh,
      estimated: row.estimatedSlots > 0,
      incomplete: row.incompleteSlots > 0
    })));
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
          <th>Erlös</th>
          <th>Kosten</th>
          <th>Netto</th>
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
            <td>${fmtEur(row.exportRevenueEur)}</td>
            <td>${fmtEur(blendedCostEur(row))}</td>
            <td>${fmtEur(blendedNetEur(row))}</td>
            ${includeSolar ? `<td>${fmtCt(row.solarMarketValueCtKwh)}</td><td>${fmtEur(row.solarCompensationEur)}</td>` : ''}
            <td>${row.incompleteSlots ? `${row.incompleteSlots} offen` : 'vollstaendig'}${row.estimatedSlots ? ` · ${row.estimatedSlots} geschätzt` : ''}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderSummary(summary) {
  historyState.lastSummary = summary;
  renderKpis(summary);
  renderCharts(summary);
  renderRows(summary);

  const unresolved = summary?.meta?.unresolved || {};
  const warningCount = Number(unresolved.incompleteSlots || 0);
  const estimatedCount = Number(unresolved.estimatedSlots || 0);
  const warningText = warningCount
    ? `${warningCount} Slots sind unvollständig, ${estimatedCount} geschätzt.`
    : estimatedCount
      ? `${estimatedCount} Slots sind geschätzt.`
      : 'Historie geladen.';
  setBanner(warningText, warningCount ? 'warn' : 'success');
  const versionLabel = summary?.app?.versionLabel ? ` · ${summary.app.versionLabel}` : '';
  setText('historyMeta', `${String(summary?.view || '').toUpperCase()} · ${summary?.date || currentDateValue()}${versionLabel}`);
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
  const opportunityBlend = byId('historyOpportunityBlend');
  if (view) view.addEventListener('change', loadHistorySummary);
  if (date) date.addEventListener('change', loadHistorySummary);
  if (backfill) backfill.addEventListener('click', triggerBackfill);
  if (prev) prev.addEventListener('click', () => stepCurrentRange(-1));
  if (next) next.addEventListener('click', () => stepCurrentRange(1));
  if (opportunityBlend) {
    opportunityBlend.addEventListener('input', (event) => {
      historyState.opportunityBlendPct = Number(event.target?.value || 0);
      updateOpportunityLabel();
      if (historyState.lastSummary) renderSummary(historyState.lastSummary);
    });
  }
}

function initHistoryPage() {
  const date = byId('historyDate');
  const opportunityBlend = byId('historyOpportunityBlend');
  if (date && !date.value) date.value = currentDateValue();
  if (opportunityBlend) historyState.opportunityBlendPct = Number(opportunityBlend.value || 0);
  updateOpportunityLabel();
  renderBackfillButtonState();
  bindHistoryControls();
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
