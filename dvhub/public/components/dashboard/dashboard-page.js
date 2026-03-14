import { html } from 'htm/preact';
import { telemetry, prices, forecast, dvStatus, execStatus, wsConnected } from '../shared/use-signal-store.js';
import { signal } from '@preact/signals';
import { PowerFlow } from './power-flow.js';
import { KpiCards } from './kpi-cards.js';
import { PriceChart } from './price-chart.js';
import { EnergyTimeline } from './energy-timeline.js';
import { ForecastChart } from './forecast-chart.js';
import { SchedulePanel } from './schedule-panel.js';
import { ControlPanel } from './control-panel.js';
import { LogPanel } from './log-panel.js';

// Energy data signal -- derived from telemetry history (placeholder for now)
const energyData = signal([]);

export function DashboardPage() {
  return html`
    <header class="panel compact-topbar reveal">
      <div class="compact-topbar-copy">
        <p class="page-kicker">Leitstand</p>
        <h1 class="page-title">DVhub Leitstand</h1>
        <p class="page-subtitle">Direktvermarktung, Energiefluesse und Automationen in einer kompakten Betriebsansicht.</p>
      </div>
      <div class="page-actions">
        <span class="ws-indicator ${wsConnected.value ? 'ws-connected' : 'ws-disconnected'}"></span>
        <a class="btn btn-ghost" href="#/settings">Einrichtung</a>
        <a class="btn btn-primary" href="#/tools">Wartung oeffnen</a>
      </div>
    </header>
    <main class="dashboard-grid">
      <!-- Row 1: Power Flow (span-6), KPI Cards (span-3), Control Panel (span-3) -->
      <section class="panel span-6 reveal">
        <p class="card-title">Energiefluss</p>
        <${PowerFlow} telemetry=${telemetry} />
      </section>
      <${KpiCards} />
      <${ControlPanel} />

      <!-- Row 2: Price Chart (span-12) -->
      <${PriceChart} prices=${prices} />

      <!-- Row 3: Energy Timeline (span-12) -->
      <${EnergyTimeline} energyData=${energyData} prices=${prices} />

      <!-- Row 4: Forecast Chart (span-6), Schedule Panel (span-6) -->
      <${ForecastChart} forecast=${forecast} />
      <${SchedulePanel} />

      <!-- Row 5: Log Panel (span-12) -->
      <${LogPanel} />
    </main>
  `;
}
