const common = window.DVhubCommon || {};
const { apiFetch } = common;

const historyState = {
  loading: false,
  backfillBusy: false,
  lastSummary: null
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

function renderBackfillButtonState() {
  const button = byId('historyBackfillBtn');
  if (!button) return;
  button.disabled = historyState.backfillBusy;
  button.textContent = historyState.backfillBusy ? 'Preise werden geladen...' : 'Preise nachladen';
}

function renderKpis(summary) {
  setText('historyKpiCost', fmtEur(summary?.kpis?.importCostEur));
  setText('historyKpiRevenue', fmtEur(summary?.kpis?.exportRevenueEur));
  setText('historyKpiNet', fmtEur(summary?.kpis?.netEur));
  setText('historyKpiImport', fmtKwh(summary?.kpis?.importKwh));
  setText('historyKpiExport', fmtKwh(summary?.kpis?.exportKwh));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function chartBadge(item) {
  const badges = [];
  if (item?.estimated) badges.push('<span class="history-point-badge">geschätzt</span>');
  if (item?.incomplete) badges.push('<span class="history-point-badge history-point-badge-warn">offen</span>');
  return badges.join('');
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

function renderLineChart(mountId, items, series, formatter) {
  const mount = byId(mountId);
  if (!mount) return;
  if (!Array.isArray(items) || !items.length) {
    mount.innerHTML = '<div class="history-chart-empty">Keine Daten fuer diese Ansicht.</div>';
    return;
  }

  const width = 320;
  const height = 150;
  const values = series.flatMap((entry) => items.map((item) => Number(item?.[entry.key])))
    .filter((value) => Number.isFinite(value));
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;

  mount.innerHTML = `
    <div class="history-line-chart">
      <div class="history-chart-legend">
        ${series.map((entry) => `<span><i class="history-legend-swatch ${entry.className}"></i>${escapeHtml(entry.label)}</span>`).join('')}
      </div>
      <svg viewBox="0 0 ${width} ${height}" class="history-line-svg" aria-hidden="true">
        <path class="history-grid-line" d="M0,${height} L${width},${height}" />
        <path class="history-grid-line" d="M0,${(height / 2).toFixed(2)} L${width},${(height / 2).toFixed(2)}" />
        ${series.map((entry) => {
          const points = items.map((item) => Number(item?.[entry.key]));
          return `<path class="history-series-line ${entry.className}" d="${linePath(points, width, height - 8, min, max)}" />`;
        }).join('')}
      </svg>
      <div class="history-chart-points">
        ${items.map((item) => `
          <div class="history-chart-point">
            <strong>${escapeHtml(item.label || item.ts || '-')}</strong>
            ${series.map((entry) => `<span>${escapeHtml(entry.label)} ${formatter(item?.[entry.key])}</span>`).join('')}
            ${chartBadge(item)}
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function stackHeight(value, max) {
  if (!Number.isFinite(Number(value)) || max <= 0) return 0;
  return Math.max(10, Math.round((Number(value) / max) * 128));
}

function renderStackChart(mountId, items) {
  const mount = byId(mountId);
  if (!mount) return;
  if (!Array.isArray(items) || !items.length) {
    mount.innerHTML = '<div class="history-chart-empty">Keine Daten fuer diese Ansicht.</div>';
    return;
  }

  const max = Math.max(...items.map((item) => (
    Number(item?.exportRevenueEur || 0)
    + Number(item?.gridCostEur || 0)
    + Number(item?.pvCostEur || 0)
    + Number(item?.batteryCostEur || 0)
  )), 0.01);

  mount.innerHTML = `
    <div class="history-stack-chart">
      <div class="history-chart-legend">
        <span><i class="history-legend-swatch history-bar-revenue"></i>Nettoerlös</span>
        <span><i class="history-legend-swatch history-bar-grid"></i>Netzkosten</span>
        <span><i class="history-legend-swatch history-bar-pv"></i>PV-Kosten</span>
        <span><i class="history-legend-swatch history-bar-battery"></i>Batteriekosten</span>
      </div>
      <div class="history-bars">
        ${items.map((item) => `
          <div class="history-bar-card">
            <div class="history-stack">
              <div class="history-bar history-bar-revenue" style="height:${stackHeight(item?.exportRevenueEur, max)}px"></div>
              <div class="history-bar history-bar-grid" style="height:${stackHeight(item?.gridCostEur, max)}px"></div>
              <div class="history-bar history-bar-pv" style="height:${stackHeight(item?.pvCostEur, max)}px"></div>
              <div class="history-bar history-bar-battery" style="height:${stackHeight(item?.batteryCostEur, max)}px"></div>
            </div>
            <strong>${fmtEur((Number(item?.exportRevenueEur || 0)) - (Number(item?.gridCostEur || 0) + Number(item?.pvCostEur || 0) + Number(item?.batteryCostEur || 0)))}</strong>
            <span>${escapeHtml(item.label || '-')}</span>
            ${item?.estimatedSlots ? `<span class="history-point-badge">${item.estimatedSlots} geschätzt</span>` : ''}
            ${item?.incompleteSlots ? `<span class="history-point-badge history-point-badge-warn">${item.incompleteSlots} offen</span>` : ''}
          </div>
        `).join('')}
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
          ${item?.estimated || item?.incomplete ? `<span>${item.incomplete ? 'offen' : 'geschätzt'}</span>` : '<span>gemessen</span>'}
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
  const periodEnergyBars = Array.isArray(charts.periodEnergyBars) ? charts.periodEnergyBars : [];

  if (String(summary?.view || '') === 'day' && dayEnergyLines.length) {
    renderLineChart('historyFinancialChart', dayFinancialLines, [
      { key: 'selfConsumptionCostEur', label: 'Kosten', className: 'history-series-cost' },
      { key: 'exportRevenueEur', label: 'Erloese', className: 'history-series-revenue' },
      { key: 'netEur', label: 'Netto', className: 'history-series-net' }
    ], fmtEur);
    renderLineChart('historyEnergyChart', dayEnergyLines, [
      { key: 'importKwh', label: 'Import', className: 'history-series-import' },
      { key: 'exportKwh', label: 'Export', className: 'history-series-export' },
      { key: 'loadKwh', label: 'Last', className: 'history-series-load' }
    ], fmtKwh);
    renderLineChart('historyPriceChart', dayPriceLines, [
      { key: 'marketPriceCtKwh', label: 'Marktpreis', className: 'history-series-market' },
      { key: 'userImportPriceCtKwh', label: 'Bezugspreis', className: 'history-series-user' }
    ], fmtCt);
    return;
  }

  renderStackChart('historyFinancialChart', periodFinancialBars);

  const energyMount = byId('historyEnergyChart');
  if (energyMount) {
    energyMount.innerHTML = `
      <div class="history-bars">
        ${periodEnergyBars.map((item) => `
          <div class="history-bar-card">
            <div class="history-stack">
              <div class="history-bar history-bar-energy" style="height:${stackHeight(item?.importKwh, Math.max(...periodEnergyBars.map((entry) => Number(entry?.importKwh || 0) + Number(entry?.exportKwh || 0)), 0.01))}px"></div>
              <div class="history-bar history-bar-export" style="height:${stackHeight(item?.exportKwh, Math.max(...periodEnergyBars.map((entry) => Number(entry?.importKwh || 0) + Number(entry?.exportKwh || 0)), 0.01))}px"></div>
            </div>
            <strong>${fmtKwh((Number(item?.importKwh || 0)) + (Number(item?.exportKwh || 0)))}</strong>
            <span>${escapeHtml(item.label || '-')}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  renderPriceList('historyPriceChart', (summary?.rows || []).map((row) => ({
    label: row.label,
    marketPriceCtKwh: row.marketPriceCtKwh,
    userImportPriceCtKwh: row.userImportPriceCtKwh,
    estimated: row.estimatedSlots > 0,
    incomplete: row.incompleteSlots > 0
  })));
}

function renderRows(summary) {
  const rows = byId('historyRows');
  if (!rows) return;
  const items = Array.isArray(summary?.rows) ? summary.rows : [];
  rows.innerHTML = items.map((row) => `
    <article class="history-row-card">
      <div class="history-row-head">
        <strong>${row.label || row.key || '-'}</strong>
        <span>
          ${row.incompleteSlots ? `${row.incompleteSlots} offen` : 'vollständig'}
          ${row.estimatedSlots ? ` · ${row.estimatedSlots} geschätzt` : ''}
        </span>
      </div>
      <div class="history-row-metrics">
        <span>Import ${fmtKwh(row.importKwh)}</span>
        <span>Export ${fmtKwh(row.exportKwh)}</span>
        <span>Netzkosten ${fmtEur(row.gridCostEur ?? row.importCostEur)}</span>
        <span>PV-Kosten ${fmtEur(row.pvCostEur)}</span>
        <span>Batterie ${fmtEur(row.batteryCostEur)}</span>
        <span>Erlöse ${fmtEur(row.exportRevenueEur)}</span>
        <span>Netto ${fmtEur(row.netEur)}</span>
      </div>
    </article>
  `).join('');
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
      body: JSON.stringify({})
    });
    const payload = await response.json();
    if (!response.ok) {
      setBanner(`Preis-Backfill fehlgeschlagen: ${payload.error || response.status}`, 'error');
      return;
    }
    await loadHistorySummary();
  } catch (error) {
    setBanner(`Preis-Backfill fehlgeschlagen: ${error.message}`, 'error');
  } finally {
    historyState.backfillBusy = false;
    renderBackfillButtonState();
  }
}

function bindHistoryControls() {
  const view = byId('historyView');
  const date = byId('historyDate');
  const backfill = byId('historyBackfillBtn');
  if (view) view.addEventListener('change', loadHistorySummary);
  if (date) date.addEventListener('change', loadHistorySummary);
  if (backfill) backfill.addEventListener('click', triggerBackfill);
}

function initHistoryPage() {
  const date = byId('historyDate');
  if (date && !date.value) date.value = currentDateValue();
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
