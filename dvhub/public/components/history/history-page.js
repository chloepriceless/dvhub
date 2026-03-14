import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { apiFetch } from '../shared/use-api.js';
import { formatEnergy, formatPercent } from '../shared/format.js';
import { HistoryChart } from './history-chart.js';

const historyData = signal([]);
const summaryStats = signal(null);
const loading = signal(false);
const error = signal(null);
const backfillStatus = signal(null);

// Date range state
const presetDays = signal(1);
const startDate = signal('');
const endDate = signal('');
const resolution = signal('1h');

const PRESETS = [
  { label: 'Heute', days: 1 },
  { label: '7 Tage', days: 7 },
  { label: '30 Tage', days: 30 },
  { label: '90 Tage', days: 90 },
];

const RESOLUTIONS = [
  { value: '5m', label: '5 min' },
  { value: '15m', label: '15 min' },
  { value: '1h', label: '1 Stunde' },
  { value: '1d', label: '1 Tag' },
];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoStr(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

async function fetchHistory() {
  loading.value = true;
  error.value = null;
  const from = startDate.value || daysAgoStr(presetDays.value);
  const to = endDate.value || todayStr();
  const res = resolution.value;
  try {
    const resp = await apiFetch(`/api/history/summary?from=${from}&to=${to}&resolution=${res}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = await resp.json();
    historyData.value = body.data || body.rows || [];
    summaryStats.value = body.summary || body.stats || null;
  } catch (err) {
    error.value = err.message;
    historyData.value = [];
    summaryStats.value = null;
  } finally {
    loading.value = false;
  }
}

function selectPreset(days) {
  presetDays.value = days;
  startDate.value = daysAgoStr(days);
  endDate.value = todayStr();
  fetchHistory();
}

async function triggerVrmBackfill() {
  backfillStatus.value = 'VRM-Import laeuft...';
  try {
    const res = await apiFetch('/api/history/backfill/vrm', { method: 'POST', body: JSON.stringify({ mode: 'gap' }) });
    const body = await res.json();
    backfillStatus.value = body.ok ? 'VRM-Backfill erfolgreich' : `Fehler: ${body.error || 'Unbekannt'}`;
  } catch (err) {
    backfillStatus.value = `Fehler: ${err.message}`;
  }
}

async function triggerPriceBackfill() {
  backfillStatus.value = 'Preis-Import laeuft...';
  try {
    const res = await apiFetch('/api/history/backfill/prices', { method: 'POST', body: JSON.stringify({}) });
    const body = await res.json();
    backfillStatus.value = body.ok ? 'Preis-Backfill erfolgreich' : `Fehler: ${body.error || 'Unbekannt'}`;
  } catch (err) {
    backfillStatus.value = `Fehler: ${err.message}`;
  }
}

export function HistoryPage() {
  useEffect(() => {
    startDate.value = daysAgoStr(1);
    endDate.value = todayStr();
    fetchHistory();
  }, []);

  const stats = summaryStats.value;

  return html`
    <header class="panel compact-topbar reveal">
      <div class="compact-topbar-copy">
        <p class="page-kicker">Auswertung</p>
        <h1 class="page-title">Historie</h1>
        <p class="page-subtitle">Historische Energie- und Preisdaten im Ueberblick.</p>
      </div>
    </header>

    <main class="dashboard-grid">
      <!-- Controls -->
      <section class="panel span-12 reveal" style="padding: 1rem;">
        <div style="display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center;">
          <!-- Presets -->
          ${PRESETS.map(p => html`
            <button
              class=${`btn ${presetDays.value === p.days ? 'btn-primary' : 'btn-ghost'}`}
              onClick=${() => selectPreset(p.days)}
            >${p.label}</button>
          `)}

          <!-- Custom dates -->
          <label style="display: flex; align-items: center; gap: 0.3rem; font-size: 0.85rem;">
            Von:
            <input type="date" value=${startDate.value}
              onInput=${(e) => { startDate.value = e.target.value; }}
              style="padding: 0.3rem; background: var(--dvhub-bg, #1a1a2e); color: inherit; border: 1px solid var(--dvhub-dim, #444); border-radius: 4px;"
            />
          </label>
          <label style="display: flex; align-items: center; gap: 0.3rem; font-size: 0.85rem;">
            Bis:
            <input type="date" value=${endDate.value}
              onInput=${(e) => { endDate.value = e.target.value; }}
              style="padding: 0.3rem; background: var(--dvhub-bg, #1a1a2e); color: inherit; border: 1px solid var(--dvhub-dim, #444); border-radius: 4px;"
            />
          </label>

          <!-- Resolution -->
          <select
            value=${resolution.value}
            onChange=${(e) => { resolution.value = e.target.value; fetchHistory(); }}
            style="padding: 0.4rem; background: var(--dvhub-bg, #1a1a2e); color: inherit; border: 1px solid var(--dvhub-dim, #444); border-radius: 4px;"
          >
            ${RESOLUTIONS.map(r => html`<option value=${r.value}>${r.label}</option>`)}
          </select>

          <button class="btn btn-primary" onClick=${fetchHistory}>Laden</button>
        </div>
      </section>

      <!-- Chart -->
      <section class="panel span-12 reveal" style="padding: 1rem;">
        ${loading.value
          ? html`<p class="meta">Daten werden geladen...</p>`
          : html`<${HistoryChart}
              data=${historyData.value}
              dateRange=${`${startDate.value} - ${endDate.value}`}
              resolution=${resolution.value}
            />`
        }
        ${error.value && html`<p class="meta" style="color: var(--dvhub-red, #f87171); margin-top: 0.5rem;">${error.value}</p>`}
      </section>

      <!-- Summary stats -->
      ${stats && html`
        <section class="panel span-12 reveal" style="padding: 1rem;">
          <p class="card-title" style="margin-bottom: 0.5rem;">Zusammenfassung</p>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem;">
            <div class="panel" style="padding: 0.75rem;">
              <p class="meta">PV Erzeugung</p>
              <strong>${formatEnergy(stats.totalPvWh || stats.pvProductionWh || 0)}</strong>
            </div>
            <div class="panel" style="padding: 0.75rem;">
              <p class="meta">Netzbezug</p>
              <strong>${formatEnergy(stats.totalImportWh || stats.gridImportWh || 0)}</strong>
            </div>
            <div class="panel" style="padding: 0.75rem;">
              <p class="meta">Einspeisung</p>
              <strong>${formatEnergy(stats.totalExportWh || stats.gridExportWh || 0)}</strong>
            </div>
            <div class="panel" style="padding: 0.75rem;">
              <p class="meta">Autarkie</p>
              <strong>${formatPercent(stats.autarkyRate || stats.autarky || 0)}</strong>
            </div>
            ${(stats.totalCost != null || stats.costEstimate != null) && html`
              <div class="panel" style="padding: 0.75rem;">
                <p class="meta">Kosten / Erloese</p>
                <strong>${((stats.totalCost ?? stats.costEstimate ?? 0) / 100).toFixed(2)} EUR</strong>
              </div>
            `}
          </div>
        </section>
      `}

      <!-- Backfill section -->
      <section class="panel span-12 reveal" style="padding: 1rem;">
        <p class="card-title" style="margin-bottom: 0.5rem;">Daten-Import</p>
        <div style="display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center;">
          <button class="btn btn-ghost" onClick=${triggerVrmBackfill}>VRM-Backfill starten</button>
          <button class="btn btn-ghost" onClick=${triggerPriceBackfill}>Preise nachladen</button>
          ${backfillStatus.value && html`<span class="meta">${backfillStatus.value}</span>`}
        </div>
      </section>
    </main>
  `;
}
