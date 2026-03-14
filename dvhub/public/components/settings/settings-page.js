import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { apiFetch } from '../shared/use-api.js';
import { SettingsSection } from './settings-section.js';
import { SettingsField } from './settings-field.js';

const configData = signal({});
const loading = signal(true);
const saving = signal(false);
const toast = signal(null);
const error = signal(null);

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

async function saveAllConfig() {
  saving.value = true;
  try {
    const res = await apiFetch('/api/config', {
      method: 'POST',
      body: JSON.stringify(configData.value),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Konfiguration gespeichert', 'success');
  } catch (err) {
    showToast(`Fehler: ${err.message}`, 'error');
  } finally {
    saving.value = false;
  }
}

function showToast(message, type) {
  toast.value = { message, type };
  setTimeout(() => { toast.value = null; }, 3000);
}

function updateField(path, value) {
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

function getField(path) {
  const parts = path.split('.');
  let obj = configData.value;
  for (const p of parts) {
    if (!obj || typeof obj !== 'object') return undefined;
    obj = obj[p];
  }
  return obj;
}

function onFieldChange(path) {
  return ({ value }) => updateField(path, value);
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
    showToast('Export erfolgreich', 'success');
  } catch (err) {
    showToast(`Export fehlgeschlagen: ${err.message}`, 'error');
  }
}

async function handleImport(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const res = await apiFetch('/api/config/import', {
      method: 'POST',
      body: text,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Import erfolgreich', 'success');
    loadConfig();
  } catch (err) {
    showToast(`Import fehlgeschlagen: ${err.message}`, 'error');
  }
}

function pvPlants() {
  return Array.isArray(configData.value.pvPlants) ? configData.value.pvPlants : [];
}

function addPvPlant() {
  const clone = JSON.parse(JSON.stringify(configData.value));
  if (!Array.isArray(clone.pvPlants)) clone.pvPlants = [];
  clone.pvPlants.push({ name: '', peakKwp: 0, azimuth: 180, tilt: 30 });
  configData.value = clone;
}

function removePvPlant(index) {
  const clone = JSON.parse(JSON.stringify(configData.value));
  clone.pvPlants.splice(index, 1);
  configData.value = clone;
}

function updatePvPlant(index, field, value) {
  const clone = JSON.parse(JSON.stringify(configData.value));
  if (clone.pvPlants?.[index]) {
    clone.pvPlants[index][field] = value;
    configData.value = clone;
  }
}

export function SettingsPage() {
  useEffect(() => { loadConfig(); }, []);

  const cfg = configData.value;
  const mods = cfg.modules || {};
  const dvEnabled = !!(mods.dv && mods.dv.enabled);
  const optEnabled = !!(mods.optimizer && mods.optimizer.enabled);

  return html`
    <header class="panel compact-topbar reveal">
      <div class="compact-topbar-copy">
        <p class="page-kicker">Konfiguration</p>
        <h1 class="page-title">Einrichtung</h1>
        <p class="page-subtitle">System- und Modulkonfiguration fuer DVhub.</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" onClick=${saveAllConfig} disabled=${saving.value}>
          ${saving.value ? 'Wird gespeichert...' : 'Speichern'}
        </button>
      </div>
    </header>

    ${toast.value && html`
      <div style=${`
        position: fixed; top: 1rem; right: 1rem; z-index: 9999;
        padding: 0.75rem 1.25rem; border-radius: 6px;
        background: ${toast.value.type === 'success' ? 'var(--dvhub-green, #4ade80)' : 'var(--dvhub-red, #f87171)'};
        color: #000; font-weight: 500;
      `}>${toast.value.message}</div>
    `}

    ${loading.value && html`<section class="panel span-12 reveal"><p class="meta">Konfiguration wird geladen...</p></section>`}
    ${error.value && html`<section class="panel span-12 reveal"><p class="meta" style="color: var(--dvhub-red, #f87171);">${error.value}</p></section>`}

    <main class="dashboard-grid">

      <!-- System -->
      <section class="span-12">
        <${SettingsSection} title="System" description="Grundlegende Systemeinstellungen">
          <${SettingsField} type="text" name="systemName" label="Systemname" value=${getField('systemName')} onChange=${onFieldChange('systemName')} hint="Anzeigename des DVhub-Systems" />
          <${SettingsField} type="number" name="pollInterval" label="Poll-Intervall (ms)" value=${getField('pollInterval')} onChange=${onFieldChange('pollInterval')} min=${500} max=${60000} step=${100} hint="Intervall fuer Modbus-Abfragen" />
          <${SettingsField} type="number" name="port" label="HTTP Port" value=${getField('port')} onChange=${onFieldChange('port')} min=${1} max=${65535} hint="Server-Port fuer das Web-Interface" />
        <//>
      </section>

      <!-- Hersteller -->
      <section class="span-12">
        <${SettingsSection} title="Hersteller" description="Wechselrichter- und Modbus-Konfiguration">
          <${SettingsField} type="select" name="manufacturer" label="Hersteller" value=${getField('manufacturer')} onChange=${onFieldChange('manufacturer')} options=${[
            { value: 'victron', label: 'Victron Energy' },
            { value: 'deye', label: 'Deye' },
            { value: 'generic', label: 'Generisch' },
          ]} />
          <${SettingsField} type="text" name="modbusHost" label="Modbus Host" value=${getField('modbusHost')} onChange=${onFieldChange('modbusHost')} hint="IP-Adresse des Wechselrichters" />
          <${SettingsField} type="number" name="modbusPort" label="Modbus Port" value=${getField('modbusPort')} onChange=${onFieldChange('modbusPort')} min=${1} max=${65535} />
          <${SettingsField} type="number" name="modbusUnitId" label="Modbus Unit ID" value=${getField('modbusUnitId')} onChange=${onFieldChange('modbusUnitId')} min=${1} max=${247} />
        <//>
      </section>

      <!-- DV-Modul (conditional) -->
      ${dvEnabled && html`
        <section class="span-12">
          <${SettingsSection} title="DV-Modul" description="Direktvermarktungs-Einstellungen">
            <${SettingsField} type="text" name="provider" label="DV-Provider" value=${getField('modules.dv.provider')} onChange=${onFieldChange('modules.dv.provider')} hint="Anbieter fuer Direktvermarktung" />
            <${SettingsField} type="text" name="dvContractId" label="Vertrags-ID" value=${getField('modules.dv.dvContractId')} onChange=${onFieldChange('modules.dv.dvContractId')} />
            <${SettingsField} type="select" name="abregelungModus" label="Abregelungsmodus" value=${getField('modules.dv.abregelungModus')} onChange=${onFieldChange('modules.dv.abregelungModus')} options=${[
              { value: 'frequency', label: 'Frequenzbasiert' },
              { value: 'power', label: 'Leistungsbasiert' },
              { value: 'off', label: 'Deaktiviert' },
            ]} />
          <//>
        </section>
      `}

      <!-- Optimierung (conditional) -->
      ${optEnabled && html`
        <section class="span-12">
          <${SettingsSection} title="Optimierung" description="EOS/EMHASS Optimierer-Einstellungen">
            <${SettingsField} type="text" name="eosUrl" label="EOS URL" value=${getField('modules.optimizer.eosUrl')} onChange=${onFieldChange('modules.optimizer.eosUrl')} hint="URL des EOS-Optimierers" />
            <${SettingsField} type="text" name="emhassUrl" label="EMHASS URL" value=${getField('modules.optimizer.emhassUrl')} onChange=${onFieldChange('modules.optimizer.emhassUrl')} hint="URL des EMHASS-Servers" />
            <${SettingsField} type="number" name="optimizerInterval" label="Optimierungs-Intervall (min)" value=${getField('modules.optimizer.optimizerInterval')} onChange=${onFieldChange('modules.optimizer.optimizerInterval')} min=${5} max=${1440} step=${5} />
          <//>
        </section>
      `}

      <!-- Boersenpreise -->
      <section class="span-12">
        <${SettingsSection} title="Boersenpreise" description="Strompreis-Konfiguration">
          <${SettingsField} type="select" name="priceSource" label="Preisquelle" value=${getField('priceSource')} onChange=${onFieldChange('priceSource')} options=${[
            { value: 'epex', label: 'EPEX Spot' },
            { value: 'tibber', label: 'Tibber API' },
            { value: 'manual', label: 'Manuell' },
          ]} />
          <${SettingsField} type="select" name="epexArea" label="EPEX-Marktgebiet" value=${getField('epexArea')} onChange=${onFieldChange('epexArea')} options=${[
            { value: 'DE-LU', label: 'Deutschland/Luxemburg' },
            { value: 'AT', label: 'Oesterreich' },
            { value: 'CH', label: 'Schweiz' },
          ]} />
          <${SettingsField} type="number" name="priceMarkup" label="Preisaufschlag (ct/kWh)" value=${getField('priceMarkup')} onChange=${onFieldChange('priceMarkup')} min=${0} max=${100} step=${0.1} hint="Aufschlag auf den Boersenpreis" />
        <//>
      </section>

      <!-- Tarifsystem -->
      <section class="span-12">
        <${SettingsSection} title="Tarifsystem" description="Tarifmodell und Zeitfenster">
          <${SettingsField} type="select" name="tariffModel" label="Tarifmodell" value=${getField('tariffModel')} onChange=${onFieldChange('tariffModel')} options=${[
            { value: 'fixed', label: 'Festpreis' },
            { value: 'dynamic', label: 'Dynamisch' },
            { value: 'multiWindow', label: 'Mehrzeitfenster (HT/NT)' },
          ]} />
          <${SettingsField} type="number" name="dynamicMarkup" label="Dynamischer Aufschlag (ct/kWh)" value=${getField('dynamicMarkup')} onChange=${onFieldChange('dynamicMarkup')} min=${0} max=${50} step=${0.1} />
          <${SettingsField} type="text" name="periods" label="Zeitperioden (JSON)" value=${typeof getField('periods') === 'object' ? JSON.stringify(getField('periods')) : getField('periods')} onChange=${onFieldChange('periods')} hint="Tarifperioden als JSON-Array" />
        <//>
      </section>

      <!-- PV-Anlagen -->
      <section class="span-12">
        <${SettingsSection} title="PV-Anlagen" description="Photovoltaik-Anlagen konfigurieren">
          ${pvPlants().map((plant, i) => html`
            <div class="panel" style="padding: 0.75rem; margin-bottom: 0.5rem; position: relative;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                <strong class="card-title">Anlage ${i + 1}</strong>
                <button class="btn btn-ghost" style="font-size: 0.8rem;" onClick=${() => removePvPlant(i)}>Entfernen</button>
              </div>
              <${SettingsField} type="text" name="name" label="Name" value=${plant.name} onChange=${({ value }) => updatePvPlant(i, 'name', value)} />
              <${SettingsField} type="number" name="peakKwp" label="Peak (kWp)" value=${plant.peakKwp} onChange=${({ value }) => updatePvPlant(i, 'peakKwp', value)} min=${0} step=${0.1} />
              <${SettingsField} type="number" name="azimuth" label="Azimut" value=${plant.azimuth} onChange=${({ value }) => updatePvPlant(i, 'azimuth', value)} min=${0} max=${360} />
              <${SettingsField} type="number" name="tilt" label="Neigung" value=${plant.tilt} onChange=${({ value }) => updatePvPlant(i, 'tilt', value)} min=${0} max=${90} />
            </div>
          `)}
          <button class="btn btn-ghost" onClick=${addPvPlant}>+ PV-Anlage hinzufuegen</button>
        <//>
      </section>

      <!-- Netzwerk -->
      <section class="span-12">
        <${SettingsSection} title="Netzwerk" description="Netzwerk- und Sicherheitseinstellungen">
          <${SettingsField} type="text" name="bindAddress" label="Bind-Adresse" value=${getField('bindAddress')} onChange=${onFieldChange('bindAddress')} hint="IP-Adresse, auf der der Server lauscht (0.0.0.0 fuer alle)" />
          <${SettingsField} type="text" name="allowedIps" label="Erlaubte IPs" value=${getField('allowedIps')} onChange=${onFieldChange('allowedIps')} hint="Kommagetrennte Liste erlaubter IP-Adressen" />
          <${SettingsField} type="toggle" name="wsTokenRequired" label="WebSocket-Token erforderlich" value=${getField('wsTokenRequired')} onChange=${onFieldChange('wsTokenRequired')} />
        <//>
      </section>

      <!-- Datenbank -->
      <section class="span-12">
        <${SettingsSection} title="Datenbank" description="Datenbank-Backend und Aufbewahrung">
          <${SettingsField} type="select" name="backend" label="Backend" value=${getField('database.backend')} onChange=${onFieldChange('database.backend')} options=${[
            { value: 'sqlite', label: 'SQLite' },
            { value: 'timescaledb', label: 'TimescaleDB' },
          ]} />
          <${SettingsField} type="number" name="retentionDays" label="Aufbewahrung (Tage)" value=${getField('database.retentionDays')} onChange=${onFieldChange('database.retentionDays')} min=${1} max=${3650} hint="Wie lange Messdaten aufbewahrt werden" />
        <//>
      </section>

      <!-- Import/Export -->
      <section class="span-12">
        <${SettingsSection} title="Import/Export" description="Konfiguration sichern oder wiederherstellen" collapsible=${false}>
          <div style="display: flex; gap: 1rem; flex-wrap: wrap;">
            <button class="btn btn-ghost" onClick=${handleExport}>Konfiguration exportieren</button>
            <label class="btn btn-ghost" style="cursor: pointer;">
              Konfiguration importieren
              <input type="file" accept=".json,application/json" style="display: none;" onChange=${handleImport} />
            </label>
          </div>
        <//>
      </section>

    </main>
  `;
}
