const common = window.DVhubCommon || {};
const { apiFetch } = common;

const historyState = {
  loading: false,
  backfillBusy: false,
  lastSummary: null,
  chartCursorByMount: {},
  opportunityBlendPct: 0,
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
  setText('historyKpiCost', fmtEur(actualCostEur(summary?.kpis)));
  setText('historyKpiRevenue', fmtEur(summary?.kpis?.exportRevenueEur));
  setText('historyKpiAvoided', fmtEur(summary?.kpis?.avoidedImportGrossEur));
  setText('historyKpiAvoidedPvGross', fmtEur(summary?.kpis?.avoidedImportPvGrossEur));
  setText('historyKpiAvoidedBatteryGross', fmtEur(summary?.kpis?.avoidedImportBatteryGrossEur));
  setText('historyKpiAvoidedPvCost', fmtEur(summary?.kpis?.pvCostEur));
  setText('historyKpiAvoidedBatteryCost', fmtEur(summary?.kpis?.batteryCostEur));
  setText('historyKpiNet', fmtEur(actualNetEur(summary?.kpis)));
  setText('historyKpiImport', fmtKwh(summary?.kpis?.importKwh));
  setText('historyKpiLoad', fmtKwh(summary?.kpis?.loadKwh));
  setText('historyKpiPv', fmtKwh(summary?.kpis?.pvKwh));
  setText('historyKpiExport', fmtKwh(summary?.kpis?.exportKwh));
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

function opportunityBlendFactor() {
  return Math.max(0, Math.min(100, Number(historyState.opportunityBlendPct || 0))) / 100;
}

function actualCostEur(item) {
  if (!item) return 0;
  return round2(
    (valueOf(item, 'gridCostEur') || valueOf(item, 'importCostEur'))
    + valueOf(item, 'pvCostEur')
    + valueOf(item, 'batteryCostEur')
  );
}

function actualNetEur(item) {
  const explicit = Number(item?.netEur);
  if (Number.isFinite(explicit)) return round2(explicit);
  return round2(valueOf(item, 'exportRevenueEur') - actualCostEur(item));
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

function linePathWithOffset(points, width, height, min, max, xOffset, yOffset = 0) {
  if (!points.length) return '';
  const span = max - min || 1;
  return points.map((point, index) => {
    const x = points.length === 1 ? xOffset + (width / 2) : xOffset + (index / (points.length - 1)) * width;
    const y = yOffset + height - (((point - min) / span) * height);
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

function renderLineChart(mountId, items, series, formatter, unitLabel, options = {}) {
  const mount = byId(mountId);
  if (!mount) return;
  if (!Array.isArray(items) || !items.length) {
    mount.innerHTML = '<div class="history-chart-empty">Keine Daten fuer diese Ansicht.</div>';
    return;
  }

  const width = Number(options.width || 420);
  const height = Number(options.height || 180);
  const marginLeft = 44;
  const marginRight = 12;
  const marginTop = 12;
  const marginBottom = 28;
  const innerWidth = width - marginLeft - marginRight;
  const innerHeight = height - marginTop - marginBottom;
  const values = series.flatMap((entry) => items.map((item) => Number(item?.[entry.key])))
    .filter((value) => Number.isFinite(value));
  const min = Number.isFinite(options.min) ? Number(options.min) : Math.min(0, ...(values.length ? values : [0]));
  const max = Math.max(...(values.length ? values : [1]), 1);
  const ticks = axisTickMeta(min, max, Number(options.tickCount || 4), formatter);
  const xTicks = xAxisTickMeta(items, Number(options.maxLabels || 6));
  const interactive = options.interactive !== false;
  const selectedIndex = selectedChartIndex(mountId, items);
  const selectedItem = items[selectedIndex] || items[0];
  const cursorX = items.length === 1
    ? marginLeft + (innerWidth / 2)
    : marginLeft + ((selectedIndex / Math.max(items.length - 1, 1)) * innerWidth);

  mount.innerHTML = `
    <div class="history-line-chart">
      <div class="history-chart-legend">
        ${series.map((entry) => `<span><i class="history-legend-swatch ${entry.className}"></i>${escapeHtml(entry.label)}</span>`).join('')}
      </div>
      <div class="history-axis-caption">${escapeHtml(unitLabel)}</div>
      <div class="history-chart-interaction">
        <svg viewBox="0 0 ${width} ${height}" class="history-line-svg${options.detail ? ' history-line-svg-detail' : ''}" aria-hidden="true">
          <g class="history-axis-y">
        ${ticks.map((tick) => {
          const y = marginTop + (tick.ratio * innerHeight);
          return `
            <path class="history-grid-line" d="M${marginLeft},${y.toFixed(2)} L${(marginLeft + innerWidth).toFixed(2)},${y.toFixed(2)}" />
            <text class="history-axis-label" x="0" y="${(y + 4).toFixed(2)}">${escapeHtml(tick.label)}</text>
          `;
        }).join('')}
          </g>
          <g class="history-axis-x">
            <path class="history-axis-baseline" d="M${marginLeft},${(marginTop + innerHeight).toFixed(2)} L${(marginLeft + innerWidth).toFixed(2)},${(marginTop + innerHeight).toFixed(2)}" />
            ${xTicks.map((tick) => {
              const x = items.length === 1 ? marginLeft + (innerWidth / 2) : marginLeft + ((tick.index / Math.max(items.length - 1, 1)) * innerWidth);
              return `<text class="history-axis-label history-x-axis-label" x="${x.toFixed(2)}" y="${(height - 6).toFixed(2)}">${escapeHtml(tick.label)}</text>`;
            }).join('')}
          </g>
        ${series.map((entry) => {
          const points = items.map((item) => Number(item?.[entry.key]));
          return `<path class="history-series-line ${entry.className}" d="${linePathWithOffset(points, innerWidth, innerHeight, min, max, marginLeft, marginTop)}" />`;
        }).join('')}
        ${interactive ? `<path class="history-cursor-line" d="M${cursorX.toFixed(2)},${marginTop} L${cursorX.toFixed(2)},${(marginTop + innerHeight).toFixed(2)}" />` : ''}
        </svg>
        ${interactive ? `<div class="history-chart-hover-surface" data-history-mount="${escapeHtml(mountId)}" aria-hidden="true"></div>` : ''}
      </div>
      ${interactive ? `
        <div class="history-chart-inspector">
          <strong>${escapeHtml(selectedItem?.label || '-')}</strong>
          ${series.map((entry) => `<span>${escapeHtml(entry.label)} ${entry.formatter ? entry.formatter(selectedItem?.[entry.key]) : formatter(selectedItem?.[entry.key])}</span>`).join('')}
          ${typeof options.inspectorExtras === 'function' ? options.inspectorExtras(selectedItem) : ''}
          ${typeof options.badgeRenderer === 'function' ? options.badgeRenderer(selectedItem) : ''}
        </div>
      ` : ''}
    </div>
  `;

  if (interactive) {
    bindLineChartPointer(mount, mountId, items, () => renderLineChart(mountId, items, series, formatter, unitLabel, options));
  }
}

function yFor(value, min, max, height) {
  const span = max - min || 1;
  return height - (((value - min) / span) * height);
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
    Number(item?.pvShareKwh || 0),
    Number(item?.batteryShareKwh || 0)
  ]), 0.01);
  const financeMax = Math.max(...items.flatMap((item) => [
    Number(item?.exportRevenueEur || 0),
    Number(item?.gridCostEur ?? item?.importCostEur ?? 0),
    Number(item?.pvCostEur || 0),
    Number(item?.batteryCostEur || 0),
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
  const renderMetric = (item, metric, max) => {
    const rawValue = metric.fallbackKey != null
      ? (item?.[metric.key] ?? item?.[metric.fallbackKey] ?? 0)
      : (item?.[metric.key] ?? 0);
    return `
      <div class="history-period-metric">
        <div class="history-period-bar-shell">
          <div class="history-bar history-bar-slim ${metric.className}" style="height:${stackHeight(rawValue, max)}px"></div>
        </div>
        <span class="history-period-metric-label">${escapeHtml(metric.label)}</span>
        <strong class="history-period-metric-value">${metric.formatter(rawValue)}</strong>
      </div>
    `;
  };

  mount.innerHTML = `
    <div class="history-stack-chart history-stack-chart-combined">
      <div class="history-chart-legend">
        <span><i class="history-legend-swatch history-bar-revenue"></i>Erlös Einspeisung</span>
        <span><i class="history-legend-swatch history-bar-cost"></i>Bezugskosten</span>
        <span><i class="history-legend-swatch history-bar-pv"></i>PV-Kosten</span>
        <span><i class="history-legend-swatch history-bar-battery"></i>Akku-Kosten</span>
        <span><i class="history-legend-swatch history-bar-grid"></i>Import</span>
        <span><i class="history-legend-swatch history-bar-pv"></i>Eigenverbrauch PV</span>
        <span><i class="history-legend-swatch history-bar-battery"></i>Eigenverbrauch Akku</span>
        <span><i class="history-legend-swatch history-bar-export"></i>Einspeisung</span>
      </div>
      <div class="history-chart-summary">
        <span>Vermiedene Bezugskosten ${fmtEur(selectedItem?.avoidedImportGrossEur)}</span>
        <span>Energie-Skala bis ${fmtKwh(energyMax)}</span>
        <span>Finanz-Skala bis ${fmtEur(financeMax)}</span>
      </div>
      <div class="history-period-clusters">
        ${items.map((item, index) => `
          <article class="history-period-cluster ${index === selectedIndex ? 'is-active' : ''} history-chart-hover-surface" data-history-index="${index}" aria-hidden="true">
            <div class="history-period-header">
              <strong>${escapeHtml(item.label || '-')}</strong>
              ${chartBadge(item)}
            </div>
            <section class="history-period-section">
              <div class="history-period-section-title">Energie</div>
              <div class="history-period-metrics">
                ${energyMetrics.map((metric) => renderMetric(item, metric, energyMax)).join('')}
              </div>
            </section>
            <section class="history-period-section">
              <div class="history-period-section-title">Finanzen</div>
              <div class="history-period-metrics">
                ${financeMetrics.map((metric) => renderMetric(item, metric, financeMax)).join('')}
              </div>
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
  const periodFinancialBars = Array.isArray(charts.periodFinancialBars) ? charts.periodFinancialBars : [];
  const periodCombinedBars = Array.isArray(charts.periodCombinedBars) ? charts.periodCombinedBars : [];

  if (String(summary?.view || '') === 'day') {
    renderLineChart('historyFinancialChart', dayFinancialLines.map((item) => ({
      ...item,
      actualCostEur: actualCostEur(item),
      actualNetEur: actualNetEur(item)
    })), [
      { key: 'actualCostEur', label: 'Kosten', className: 'history-series-cost' },
      { key: 'exportRevenueEur', label: 'Erloese', className: 'history-series-revenue' },
      { key: 'actualNetEur', label: 'Netto', className: 'history-series-net' }
    ], fmtEur, 'EUR');
    renderDetailedDayChart('historyEnergyChart', dayEnergyLines);
    renderLineChart('historyPriceChart', dayPriceLines, [
      { key: 'marketPriceCtKwh', label: 'Marktpreis', className: 'history-series-market' },
      { key: 'userImportPriceCtKwh', label: 'Bezugspreis', className: 'history-series-user' }
    ], fmtCt, 'ct/kWh');
    return;
  }

  renderCombinedPeriodBars('historyFinancialChart', periodCombinedBars.length ? periodCombinedBars : periodFinancialBars);
  setHtml('historyEnergyChart', '');
  setHtml('historyPriceChart', '');
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
            <td>${fmtEur(actualCostEur(row))}</td>
            <td>${fmtEur(actualNetEur(row))}</td>
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
  const isDayView = String(summary?.view || '') === 'day';
  const chartGrid = byId('historyChartGrid');
  const financialPanel = byId('historyFinancialPanel');
  const energyPanel = byId('historyEnergyPanel');
  const pricePanel = byId('historyPricePanel');
  if (chartGrid) {
    chartGrid.className = `history-chart-grid reveal ${isDayView ? 'history-chart-grid-day' : 'history-chart-grid-aggregated'}`;
  }
  if (financialPanel) {
    financialPanel.hidden = false;
    financialPanel.className = `panel history-chart-panel ${isDayView ? '' : 'history-chart-panel-wide'}`.trim();
  }
  if (energyPanel) energyPanel.hidden = !isDayView;
  if (pricePanel) pricePanel.hidden = !isDayView;
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
