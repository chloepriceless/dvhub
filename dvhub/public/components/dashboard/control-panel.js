import { html } from 'htm/preact';
import { telemetry, dvStatus, execStatus } from '../shared/use-signal-store.js';
import { formatPower } from '../shared/format.js';
import { apiFetch } from '../shared/use-api.js';
import { signal } from '@preact/signals';

const controlMsg = signal('');

async function sendControl(action, value) {
  controlMsg.value = '';
  try {
    const res = await apiFetch('/api/control/write', {
      method: 'POST',
      body: JSON.stringify({ action, value }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    controlMsg.value = data.message || 'OK';
  } catch (err) {
    controlMsg.value = `Fehler: ${err.message}`;
  }
}

/**
 * Control panel: DV control value, switch status, manual overrides.
 */
export function ControlPanel() {
  const t = telemetry.value || {};
  const dv = dvStatus.value || {};
  const exec = execStatus.value || {};

  const now = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return html`
    <section class="panel span-3 reveal">
      <p class="card-title">Steuerung</p>

      <div class="metric-row">
        <span>DV Sollwert</span>
        <strong class="big-value">${formatPower(dv.controlValueW)}</strong>
      </div>
      <div class="metric-row">
        <span>Schaltstatus</span>
        <strong style="color:${dv.switchOn ? 'var(--dvhub-green)' : 'var(--dvhub-red)'}">
          ${dv.switchOn ? 'EIN' : 'AUS'}
        </strong>
      </div>
      <div class="metric-row">
        <span>Netz-Sollwert</span>
        <strong>${formatPower(exec.gridSetpointW)}</strong>
      </div>
      <div class="metric-row">
        <span>Intent-Quelle</span>
        <strong style="color:var(--text-muted)">${exec.activeSource || '-'}</strong>
      </div>
      <div class="metric-row">
        <span>Uhrzeit</span>
        <strong style="color:var(--text-muted)">${now}</strong>
      </div>

      <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-ghost" onclick=${() => sendControl('switch', true)}>EIN</button>
        <button class="btn btn-ghost" onclick=${() => sendControl('switch', false)}>AUS</button>
        <button class="btn btn-ghost" onclick=${() => sendControl('setpoint', 0)}>0 W</button>
      </div>

      ${controlMsg.value && html`
        <p class="meta" style="margin-top:6px;font-size:0.8rem">${controlMsg.value}</p>
      `}
    </section>
  `;
}
