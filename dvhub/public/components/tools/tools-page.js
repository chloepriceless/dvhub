import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { apiFetch } from '../shared/use-api.js';
import { wsConnected } from '../shared/use-signal-store.js';

const health = signal(null);
const version = signal(null);
const systems = signal([]);
const modbusStatus = signal(null);
const scanResults = signal([]);
const scanning = signal(false);
const restarting = signal(false);
const loading = signal(true);
const actionMsg = signal(null);

function showMsg(text, type) {
  actionMsg.value = { text, type };
  setTimeout(() => { actionMsg.value = null; }, 4000);
}

async function loadHealth() {
  try {
    const res = await apiFetch('/api/admin/health');
    if (res.ok) health.value = await res.json();
  } catch (_) { /* optional */ }
}

async function loadVersion() {
  try {
    const res = await apiFetch('/api/version');
    if (res.ok) version.value = await res.json();
  } catch (_) { /* optional */ }
}

async function loadSystems() {
  try {
    const res = await apiFetch('/api/discovery/systems');
    if (res.ok) systems.value = await res.json();
  } catch (_) { /* optional */ }
}

async function loadModbusStatus() {
  try {
    const res = await apiFetch('/api/keepalive/modbus');
    if (res.ok) modbusStatus.value = await res.json();
  } catch (_) { /* optional */ }
}

async function handleRestart() {
  if (!confirm('Dienst wirklich neu starten?')) return;
  restarting.value = true;
  try {
    const res = await apiFetch('/api/admin/service/restart', { method: 'POST' });
    if (res.ok) {
      showMsg('Neustart eingeleitet', 'success');
    } else {
      showMsg('Neustart fehlgeschlagen', 'error');
    }
  } catch (err) {
    showMsg(`Fehler: ${err.message}`, 'error');
  } finally {
    restarting.value = false;
  }
}

async function handleMeterScan() {
  scanning.value = true;
  scanResults.value = [];
  try {
    const res = await apiFetch('/api/meter/scan', { method: 'POST' });
    if (res.ok) {
      const body = await res.json();
      scanResults.value = body.results || body.devices || [];
      showMsg('Scan abgeschlossen', 'success');
    } else {
      showMsg('Scan fehlgeschlagen', 'error');
    }
  } catch (err) {
    showMsg(`Fehler: ${err.message}`, 'error');
  } finally {
    scanning.value = false;
  }
}

async function handleExport() {
  try {
    const res = await apiFetch('/api/config/export');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dvhub-config.json';
    a.click();
    URL.revokeObjectURL(url);
    showMsg('Export erfolgreich', 'success');
  } catch (err) {
    showMsg(`Export fehlgeschlagen: ${err.message}`, 'error');
  }
}

async function handleImport(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const res = await apiFetch('/api/config/import', { method: 'POST', body: text });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showMsg('Import erfolgreich', 'success');
  } catch (err) {
    showMsg(`Import fehlgeschlagen: ${err.message}`, 'error');
  }
}

export function ToolsPage() {
  useEffect(() => {
    Promise.all([loadHealth(), loadVersion(), loadSystems(), loadModbusStatus()])
      .finally(() => { loading.value = false; });
  }, []);

  const h = health.value;
  const v = version.value;

  return html`
    <header class="panel compact-topbar reveal">
      <div class="compact-topbar-copy">
        <p class="page-kicker">System</p>
        <h1 class="page-title">Wartung</h1>
        <p class="page-subtitle">Systemwartung, Diagnose und manuelle Eingriffe.</p>
      </div>
    </header>

    ${actionMsg.value && html`
      <div style=${`
        position: fixed; top: 1rem; right: 1rem; z-index: 9999;
        padding: 0.75rem 1.25rem; border-radius: 6px;
        background: ${actionMsg.value.type === 'success' ? 'var(--dvhub-green, #4ade80)' : 'var(--dvhub-red, #f87171)'};
        color: #000; font-weight: 500;
      `}>${actionMsg.value.text}</div>
    `}

    <main class="dashboard-grid">

      <!-- System Health -->
      <section class="panel span-12 reveal" style="padding: 1rem;">
        <p class="card-title">Systemstatus</p>
        <h2 class="section-title" style="margin-top: 0.25rem;">System Health</h2>
        ${loading.value && html`<p class="meta">Status wird geladen...</p>`}
        ${h && html`
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.75rem; margin-top: 0.75rem;">
            <div class="panel" style="padding: 0.5rem;">
              <p class="meta">Module</p>
              <strong>${h.modules?.map(m => m.name || m).join(', ') || '-'}</strong>
            </div>
            <div class="panel" style="padding: 0.5rem;">
              <p class="meta">Uptime</p>
              <strong>${h.uptime ? `${Math.round(h.uptime / 60)} min` : '-'}</strong>
            </div>
            <div class="panel" style="padding: 0.5rem;">
              <p class="meta">Speicher</p>
              <strong>${h.memory?.rss ? `${Math.round(h.memory.rss / 1024 / 1024)} MB` : '-'}</strong>
            </div>
            <div class="panel" style="padding: 0.5rem;">
              <p class="meta">CPU</p>
              <strong>${h.cpu?.user != null ? `${(h.cpu.user / 1e6).toFixed(1)}s` : '-'}</strong>
            </div>
          </div>
        `}
        <div style="margin-top: 0.75rem; display: flex; align-items: center; gap: 0.5rem;">
          <span style=${`width: 10px; height: 10px; border-radius: 50%; background: ${wsConnected.value ? 'var(--dvhub-green, #4ade80)' : 'var(--dvhub-red, #f87171)'};`}></span>
          <span class="meta">WebSocket: ${wsConnected.value ? 'Verbunden' : 'Getrennt'}</span>
        </div>
      </section>

      <!-- Service Control -->
      <section class="panel span-6 reveal" style="padding: 1rem;">
        <p class="card-title">Dienstverwaltung</p>
        <h2 class="section-title" style="margin-top: 0.25rem;">Service Control</h2>
        <div style="margin-top: 0.75rem;">
          <button class="btn btn-primary" onClick=${handleRestart} disabled=${restarting.value}>
            ${restarting.value ? 'Wird neu gestartet...' : 'Dienst neu starten'}
          </button>
        </div>
      </section>

      <!-- Diagnostics -->
      <section class="panel span-6 reveal" style="padding: 1rem;">
        <p class="card-title">Diagnose</p>
        <h2 class="section-title" style="margin-top: 0.25rem;">Diagnostics</h2>
        ${modbusStatus.value && html`
          <div style="margin-top: 0.75rem;">
            <p class="meta">Modbus Keepalive: <strong>${modbusStatus.value.connected ? 'Verbunden' : 'Getrennt'}</strong></p>
          </div>
        `}
        <div style="margin-top: 0.75rem;">
          <button class="btn btn-ghost" onClick=${handleMeterScan} disabled=${scanning.value}>
            ${scanning.value ? 'Scan laeuft...' : 'Meter-Scan starten'}
          </button>
          ${scanResults.value.length > 0 && html`
            <div style="margin-top: 0.5rem;">
              ${scanResults.value.map(r => html`
                <div class="panel" style="padding: 0.5rem; margin-bottom: 0.25rem;">
                  <strong>${r.name || r.address || 'Geraet'}</strong>
                  <span class="meta" style="margin-left: 0.5rem;">${r.type || r.model || ''}</span>
                </div>
              `)}
            </div>
          `}
        </div>
      </section>

      <!-- Version -->
      <section class="panel span-6 reveal" style="padding: 1rem;">
        <p class="card-title">Software</p>
        <h2 class="section-title" style="margin-top: 0.25rem;">Version</h2>
        ${v && html`
          <div style="margin-top: 0.5rem;">
            <p class="meta">App-Version: <strong>${v.version || v.appVersion || '-'}</strong></p>
            <p class="meta">Node.js: <strong>${v.nodeVersion || v.node || '-'}</strong></p>
          </div>
        `}
        ${!v && !loading.value && html`<p class="meta">Versionsinformation nicht verfuegbar</p>`}
      </section>

      <!-- System Discovery -->
      <section class="panel span-6 reveal" style="padding: 1rem;">
        <p class="card-title">Netzwerk</p>
        <h2 class="section-title" style="margin-top: 0.25rem;">Erkannte Systeme</h2>
        ${systems.value.length > 0
          ? systems.value.map(s => html`
              <div class="panel" style="padding: 0.5rem; margin-top: 0.5rem;">
                <strong>${s.name || s.host || 'System'}</strong>
                <span class="meta" style="margin-left: 0.5rem;">${s.host || s.ip || ''}</span>
              </div>
            `)
          : html`<p class="meta" style="margin-top: 0.5rem;">Keine Systeme erkannt</p>`
        }
      </section>

      <!-- Import/Export -->
      <section class="panel span-12 reveal" style="padding: 1rem;">
        <p class="card-title">Konfiguration</p>
        <h2 class="section-title" style="margin-top: 0.25rem;">Import / Export</h2>
        <div style="display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 0.75rem;">
          <button class="btn btn-ghost" onClick=${handleExport}>Config exportieren</button>
          <label class="btn btn-ghost" style="cursor: pointer;">
            Config importieren
            <input type="file" accept=".json,application/json" style="display: none;" onChange=${handleImport} />
          </label>
        </div>
      </section>

    </main>
  `;
}
