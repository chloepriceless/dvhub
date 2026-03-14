import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { apiFetch } from '../shared/use-api.js';
import { SetupStep } from './setup-step.js';
import { ModuleToggle, buildModuleConfig } from './module-toggle.js';

const currentStep = signal(1);
const completedSteps = signal(new Set());
const configData = signal({});
const loading = signal(true);
const error = signal(null);
const systems = signal([]);

const TOTAL_STEPS = 5;

const MANUFACTURERS = [
  { value: 'victron', label: 'Victron Energy' },
  { value: 'deye', label: 'Deye' },
  { value: 'generic', label: 'Generisch' },
];

async function loadConfig() {
  loading.value = true;
  error.value = null;
  try {
    const res = await apiFetch('/api/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    configData.value = await res.json();
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

async function loadSystems() {
  try {
    const res = await apiFetch('/api/discovery/systems');
    if (res.ok) {
      systems.value = await res.json();
    }
  } catch (_) {
    // discovery optional
  }
}

async function saveConfig(patch) {
  const merged = { ...configData.value, ...patch };
  try {
    const res = await apiFetch('/api/config', {
      method: 'POST',
      body: JSON.stringify(merged),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    configData.value = merged;
    return true;
  } catch (err) {
    error.value = err.message;
    return false;
  }
}

function markComplete(step) {
  const s = new Set(completedSteps.value);
  s.add(step);
  completedSteps.value = s;
}

function goNext() {
  markComplete(currentStep.value);
  if (currentStep.value < TOTAL_STEPS) {
    currentStep.value = currentStep.value + 1;
  }
}

function goPrev() {
  if (currentStep.value > 1) {
    currentStep.value = currentStep.value - 1;
  }
}

function handleModuleToggle(moduleName, enabled) {
  const newCfg = buildModuleConfig(configData.value, moduleName, enabled);
  configData.value = newCfg;
}

function handleFieldChange(path, value) {
  const clone = JSON.parse(JSON.stringify(configData.value));
  const parts = path.split('.');
  let obj = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  obj[parts[parts.length - 1]] = value;
  configData.value = clone;
}

export function SetupPage() {
  useEffect(() => {
    loadConfig();
    loadSystems();
  }, []);

  const cfg = configData.value;
  const step = currentStep.value;
  const done = completedSteps.value;
  const mods = cfg.modules || {};

  return html`
    <header class="panel compact-topbar reveal">
      <div class="compact-topbar-copy">
        <p class="page-kicker">Ersteinrichtung</p>
        <h1 class="page-title">DVhub Inbetriebnahme</h1>
        <p class="page-subtitle">Der Assistent fuehrt durch die Pflichtangaben in ${TOTAL_STEPS} Schritten.</p>
      </div>
      <div class="page-actions">
        <span class="meta">Schritt ${step} von ${TOTAL_STEPS}</span>
      </div>
    </header>

    <main class="dashboard-grid">
      ${loading.value && html`<section class="panel span-12 reveal"><p class="meta">Konfiguration wird geladen...</p></section>`}
      ${error.value && html`<section class="panel span-12 reveal"><p class="meta" style="color: var(--dvhub-red, #f87171);">${error.value}</p></section>`}

      <section class="span-12" style="display: flex; flex-direction: column; gap: 0;">

        <${SetupStep}
          stepNumber=${1}
          title="Verbindung"
          description="Systemverbindung pruefen"
          active=${step === 1}
          completed=${done.has(1)}
        >
          <div>
            <p class="meta" style="margin-bottom: 0.5rem;">Erkannte Systeme:</p>
            ${systems.value.length > 0
              ? systems.value.map(s => html`<div class="panel" style="padding: 0.5rem; margin-bottom: 0.25rem;"><strong>${s.name || s.host || 'System'}</strong> <span class="meta">${s.host || ''}</span></div>`)
              : html`<p class="meta">Keine Systeme gefunden. Stellen Sie sicher, dass Ihr Wechselrichter im Netzwerk erreichbar ist.</p>`
            }
          </div>
        <//>

        <${SetupStep}
          stepNumber=${2}
          title="Module"
          description="Module aktivieren oder deaktivieren"
          active=${step === 2}
          completed=${done.has(2)}
        >
          <div>
            <${ModuleToggle}
              moduleName="dv"
              label="Direktvermarktung (DV)"
              description="Messwert-Lieferung und Abregelung"
              enabled=${!!(mods.dv && mods.dv.enabled)}
              onToggle=${handleModuleToggle}
            />
            <${ModuleToggle}
              moduleName="optimizer"
              label="Optimierung (HEMS)"
              description="Preisoptimierung mit EOS/EMHASS"
              enabled=${!!(mods.optimizer && mods.optimizer.enabled)}
              onToggle=${handleModuleToggle}
            />
          </div>
        <//>

        <${SetupStep}
          stepNumber=${3}
          title="Hersteller"
          description="Wechselrichter-Hersteller waehlen"
          active=${step === 3}
          completed=${done.has(3)}
        >
          <div>
            <label class="input-label" style="display: block; margin-bottom: 0.5rem;">Hersteller</label>
            <select
              class="input-field"
              value=${cfg.manufacturer || 'victron'}
              onChange=${(e) => handleFieldChange('manufacturer', e.target.value)}
              style="width: 100%; padding: 0.5rem;"
            >
              ${MANUFACTURERS.map(m => html`<option value=${m.value}>${m.label}</option>`)}
            </select>
          </div>
        <//>

        <${SetupStep}
          stepNumber=${4}
          title="Netzwerk"
          description="IP, Port und Modbus-Adresse konfigurieren"
          active=${step === 4}
          completed=${done.has(4)}
        >
          <div style="display: flex; flex-direction: column; gap: 0.75rem;">
            <div>
              <label class="input-label">Modbus Host / IP</label>
              <input class="input-field" type="text" style="width: 100%; padding: 0.5rem;"
                value=${cfg.modbusHost || ''}
                onInput=${(e) => handleFieldChange('modbusHost', e.target.value)}
                placeholder="192.168.1.100"
              />
            </div>
            <div>
              <label class="input-label">Modbus Port</label>
              <input class="input-field" type="number" style="width: 100%; padding: 0.5rem;"
                value=${cfg.modbusPort || 502}
                onInput=${(e) => handleFieldChange('modbusPort', Number(e.target.value))}
                min="1" max="65535"
              />
            </div>
            <div>
              <label class="input-label">Modbus Unit ID</label>
              <input class="input-field" type="number" style="width: 100%; padding: 0.5rem;"
                value=${cfg.modbusUnitId || 1}
                onInput=${(e) => handleFieldChange('modbusUnitId', Number(e.target.value))}
                min="1" max="247"
              />
            </div>
          </div>
        <//>

        <${SetupStep}
          stepNumber=${5}
          title="Fertig"
          description="Zusammenfassung und Uebernahme"
          active=${step === 5}
          completed=${done.has(5)}
        >
          <div>
            <p class="meta" style="margin-bottom: 0.75rem;">Ihre Konfiguration:</p>
            <ul style="list-style: none; padding: 0; margin: 0;">
              <li class="meta"><strong>Hersteller:</strong> ${cfg.manufacturer || 'victron'}</li>
              <li class="meta"><strong>DV-Modul:</strong> ${mods.dv?.enabled ? 'Aktiv' : 'Inaktiv'}</li>
              <li class="meta"><strong>Optimierung:</strong> ${mods.optimizer?.enabled ? 'Aktiv' : 'Inaktiv'}</li>
              <li class="meta"><strong>Modbus:</strong> ${cfg.modbusHost || '-'}:${cfg.modbusPort || 502} (Unit ${cfg.modbusUnitId || 1})</li>
            </ul>
            <button
              class="btn btn-primary"
              style="margin-top: 1rem;"
              onClick=${async () => {
                const ok = await saveConfig(configData.value);
                if (ok) markComplete(5);
              }}
            >
              Konfiguration uebernehmen
            </button>
          </div>
        <//>

      </section>

      <section class="span-12" style="display: flex; justify-content: space-between; padding: 0.5rem 0;">
        <button class="btn btn-ghost" onClick=${goPrev} disabled=${step === 1}>Zurueck</button>
        ${step < TOTAL_STEPS
          ? html`<button class="btn btn-primary" onClick=${goNext}>Weiter</button>`
          : null
        }
      </section>
    </main>
  `;
}
