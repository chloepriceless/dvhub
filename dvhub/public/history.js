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

function barHeight(value, maxAbs) {
  if (!Number.isFinite(Number(value)) || maxAbs <= 0) return 6;
  return Math.max(6, Math.round((Math.abs(value) / maxAbs) * 140));
}

function renderBarChart(mountId, items, formatter, valueKey, colorClass) {
  const mount = byId(mountId);
  if (!mount) return;
  const values = items.map((item) => Number(item?.[valueKey] || 0));
  const maxAbs = Math.max(...values.map((value) => Math.abs(value)), 0);
  mount.innerHTML = `
    <div class="history-bars">
      ${items.map((item) => `
        <div class="history-bar-card">
          <div class="history-bar history-bar-${colorClass}" style="height:${barHeight(item?.[valueKey], maxAbs)}px"></div>
          <strong>${formatter(item?.[valueKey])}</strong>
          <span>${item.label || item.ts || '-'}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function normalizeChartItems(summary) {
  const rows = Array.isArray(summary?.rows) ? summary.rows : [];
  if (!rows.length) return [];
  return rows.map((row) => ({
    label: row.label,
    netEur: row.netEur,
    importKwh: row.importKwh,
    exportKwh: row.exportKwh,
    marketPriceCtKwh: row.marketPriceCtKwh ?? null,
    userImportPriceCtKwh: row.userImportPriceCtKwh ?? null
  }));
}

function renderCharts(summary) {
  const baseItems = Array.isArray(summary?.rows) && summary.rows.length
    ? summary.rows
    : (summary?.series?.financial || []).map((entry) => ({
      label: entry.ts,
      netEur: entry.netEur,
      importKwh: summary?.series?.energy?.find((item) => item.ts === entry.ts)?.importKwh || 0,
      exportKwh: summary?.series?.energy?.find((item) => item.ts === entry.ts)?.exportKwh || 0,
      marketPriceCtKwh: summary?.series?.prices?.find((item) => item.ts === entry.ts)?.marketPriceCtKwh ?? null,
      userImportPriceCtKwh: summary?.series?.prices?.find((item) => item.ts === entry.ts)?.userImportPriceCtKwh ?? null
    }));

  renderBarChart('historyFinancialChart', baseItems, fmtEur, 'netEur', 'net');
  renderBarChart('historyEnergyChart', baseItems.map((item) => ({
    ...item,
    energyMix: round2((item.importKwh || 0) + (item.exportKwh || 0))
  })), fmtKwh, 'energyMix', 'energy');

  const priceMount = byId('historyPriceChart');
  if (!priceMount) return;
  priceMount.innerHTML = `
    <div class="history-price-list">
      ${baseItems.map((item) => `
        <div class="history-price-row">
          <strong>${item.label || '-'}</strong>
          <span>Markt ${fmtCt(item.marketPriceCtKwh)}</span>
          <span>Bezug ${fmtCt(item.userImportPriceCtKwh)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderRows(summary) {
  const rows = byId('historyRows');
  if (!rows) return;
  const items = Array.isArray(summary?.rows) ? summary.rows : [];
  rows.innerHTML = items.map((row) => `
    <article class="history-row-card">
      <div class="history-row-head">
        <strong>${row.label || row.key || '-'}</strong>
        <span>${row.incompleteSlots ? `${row.incompleteSlots} offen` : 'vollständig'}</span>
      </div>
      <div class="history-row-metrics">
        <span>Import ${fmtKwh(row.importKwh)}</span>
        <span>Export ${fmtKwh(row.exportKwh)}</span>
        <span>Kosten ${fmtEur(row.importCostEur)}</span>
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
  const warningText = warningCount
    ? `${warningCount} Slots sind unvollständig oder ohne Preisauflösung.`
    : 'Historie geladen.';
  setBanner(warningText, warningCount ? 'warn' : 'success');
  setText('historyMeta', `${String(summary?.view || '').toUpperCase()} · ${summary?.date || currentDateValue()}`);
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
