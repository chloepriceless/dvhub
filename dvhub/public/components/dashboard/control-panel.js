import { html } from 'htm/preact';
import { useEffect } from 'preact/hooks';
import { telemetry, dvStatus, execStatus } from '../shared/use-signal-store.js';
import { formatPower } from '../shared/format.js';
import { apiFetch } from '../shared/use-api.js';
import { signal } from '@preact/signals';
import { createPendingState, computeRenderState } from './control-compute.js';

const controlMsg = signal('');

// Min SOC slider state
const minSocPending = signal(null);     // pending state object or null
const minSocStatus = signal('idle');    // 'idle' | 'pending' | 'confirmed' | 'error'
const minSocError = signal('');
const minSocPreview = signal(null);     // slider preview value (while dragging)

// Charge current input state
const chargeCurrentValue = signal('');

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

async function submitMinSoc(value) {
  const numValue = Number(value);
  if (!Number.isFinite(numValue)) return;

  const currentReadback = telemetry.value?.victron?.minSocPct;
  minSocError.value = '';

  try {
    const res = await apiFetch('/api/control/write', {
      method: 'POST',
      body: JSON.stringify({ target: 'minSocPct', value: numValue }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.message || 'Write failed');

    minSocPending.value = createPendingState({
      currentReadback,
      submittedValue: numValue
    });
    minSocStatus.value = 'pending';
  } catch (err) {
    minSocStatus.value = 'error';
    minSocError.value = err.message;
    setTimeout(() => {
      if (minSocStatus.value === 'error') minSocStatus.value = 'idle';
    }, 4000);
  }
}

async function submitChargeCurrent() {
  const value = Number(chargeCurrentValue.value);
  if (!Number.isFinite(value)) return;

  controlMsg.value = '';
  try {
    const res = await apiFetch('/api/control/write', {
      method: 'POST',
      body: JSON.stringify({ target: 'chargeCurrentA', value }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    controlMsg.value = data.message || 'Ladestrom gesetzt';
    chargeCurrentValue.value = '';
  } catch (err) {
    controlMsg.value = `Fehler: ${err.message}`;
  }
}

async function refreshEpex() {
  controlMsg.value = '';
  try {
    const res = await apiFetch('/api/epex/refresh', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    controlMsg.value = 'EPEX Daten aktualisiert';
  } catch (err) {
    controlMsg.value = `Fehler: ${err.message}`;
  }
}

/**
 * Control panel: DV control value, switch status, manual overrides,
 * Min SOC slider, charge current input, EPEX refresh.
 */
export function ControlPanel() {
  const t = telemetry.value || {};
  const dv = dvStatus.value || {};
  const exec = execStatus.value || {};

  const now = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // Resolve pending Min SOC state on telemetry updates
  useEffect(() => {
    if (!minSocPending.value) return;
    const readbackValue = t.victron?.minSocPct;
    const render = computeRenderState({ readbackValue, pendingState: minSocPending.value });
    minSocPending.value = render.pendingState;
    if (!render.shouldBlink && minSocStatus.value === 'pending') {
      minSocStatus.value = 'confirmed';
      setTimeout(() => {
        if (minSocStatus.value === 'confirmed') minSocStatus.value = 'idle';
      }, 2000);
    }
  }, [t]);

  // Current Min SOC readback
  const currentMinSoc = t.victron?.minSocPct;
  const displayMinSoc = minSocPreview.value != null ? minSocPreview.value : currentMinSoc;

  // Status-dependent styling for Min SOC value
  const socStatus = minSocStatus.value;
  const socValueClass = socStatus === 'pending' ? 'blink-orange' : '';
  const socValueStyle = socStatus === 'confirmed'
    ? 'color:var(--dvhub-green)'
    : socStatus === 'error'
      ? 'color:var(--dvhub-red)'
      : '';

  return html`
    <style>
      @keyframes blink-orange {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }
      .blink-orange {
        animation: blink-orange 0.8s ease-in-out infinite;
        color: var(--dvhub-orange);
      }
    </style>
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

      <hr style="border-color:var(--line);margin:10px 0" />

      <!-- Min SOC Slider (CTRL-01) -->
      <div class="metric-row" style="flex-direction:column;align-items:stretch;gap:4px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span>Min SOC</span>
          <strong class="${socValueClass}" style="${socValueStyle}">
            ${displayMinSoc != null ? `${Math.round(displayMinSoc)} %` : '-'}
          </strong>
        </div>
        <input
          type="range"
          min="0" max="100" step="1"
          value=${currentMinSoc != null ? currentMinSoc : 0}
          oninput=${(e) => { minSocPreview.value = Number(e.target.value); }}
          onchange=${(e) => { minSocPreview.value = null; submitMinSoc(e.target.value); }}
          style="width:100%"
        />
        ${minSocError.value && html`
          <span class="meta" style="color:var(--dvhub-red);font-size:0.75rem">${minSocError.value}</span>
        `}
      </div>

      <!-- Charge Current Input (CTRL-02) -->
      <div class="metric-row" style="margin-top:8px;gap:6px">
        <input
          type="number"
          placeholder="Ladestrom (A)"
          value=${chargeCurrentValue.value}
          oninput=${(e) => { chargeCurrentValue.value = e.target.value; }}
          onkeydown=${(e) => { if (e.key === 'Enter') submitChargeCurrent(); }}
          style="flex:1;padding:4px 8px;background:var(--bg-card);color:var(--text);border:1px solid var(--line);border-radius:4px"
        />
      </div>

      <!-- EPEX Refresh Button (CTRL-03) -->
      <div style="margin-top:8px">
        <button class="btn btn-ghost" onclick=${refreshEpex}>EPEX aktualisieren</button>
      </div>

      ${controlMsg.value && html`
        <p class="meta" style="margin-top:6px;font-size:0.8rem">${controlMsg.value}</p>
      `}
    </section>
  `;
}
