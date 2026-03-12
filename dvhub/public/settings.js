const common = typeof window !== 'undefined' ? window.DVhubCommon || {} : {};
const { apiFetch, buildApiUrl, setStoredApiToken } = common;

let definition = null;
let currentRawConfig = {};
let currentDraftConfig = {};
let currentEffectiveConfig = {};
let currentMeta = null;
let currentHealth = null;
let currentHistoryImportStatus = null;
let currentHistoryImportResult = null;
let historyImportBusy = false;
let historyImportFormState = {
  start: '',
  end: ''
};
let pricingPeriodsDraft = [];
let pricingPeriodsValidation = [];
let marketValueModeDraft = 'annual';
let pvPlantsDraft = [];
let pvPlantsValidation = [];
let settingsShellState = createSettingsShellState();
let settingsDiscoveryStates = {};

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function getSettingsSectionFields(definitionLike, sectionId) {
  return (definitionLike?.fields || []).filter((field) => field.section === sectionId);
}

function countSettingsGroups(fields) {
  return new Set(fields.map((field) => field.group || 'main')).size;
}

function getDestinationMeta(definitionLike, destinationId) {
  return (definitionLike?.destinations || []).find((destination) => destination.id === destinationId) || null;
}

function buildSectionDestination(section, fields) {
  return {
    id: section.id,
    kind: 'section',
    label: section.label,
    description: section.description || '',
    intro: section.description || '',
    fieldCount: fields.length,
    groupCount: countSettingsGroups(fields),
    sectionCount: 1,
    sectionIds: [section.id],
    sections: [section]
  };
}

function buildSettingsDestinations(definitionLike) {
  const sectionsWithFields = (definitionLike?.sections || [])
    .map((section) => {
      const fields = getSettingsSectionFields(definitionLike, section.id);
      if (!fields.length) return null;
      return { ...section, fields, fieldCount: fields.length, groupCount: countSettingsGroups(fields) };
    })
    .filter(Boolean);

  const destinationDefinitions = definitionLike?.destinations || [];
  if (!destinationDefinitions.length) {
    return sectionsWithFields.map((section) => buildSectionDestination(section, section.fields));
  }

  const sectionDestinations = destinationDefinitions
    .map((destination) => {
      const sections = sectionsWithFields.filter((section) => section.destination === destination.id);
      if (!sections.length) return null;
      return {
        id: destination.id,
        kind: 'destination',
        label: destination.label,
        description: destination.description || '',
        intro: destination.intro || destination.description || '',
        fieldCount: sections.reduce((sum, section) => sum + section.fieldCount, 0),
        groupCount: sections.reduce((sum, section) => sum + section.groupCount, 0),
        sectionCount: sections.length,
        sectionIds: sections.map((section) => section.id),
        sections
      };
    })
    .filter(Boolean);

  for (const section of sectionsWithFields) {
    if (sectionDestinations.some((destination) => destination.sectionIds.includes(section.id))) continue;
    sectionDestinations.push(buildSectionDestination(section, section.fields));
  }

  return sectionDestinations;
}

function resolveActiveSettingsSection(destinations, requestedId) {
  const ids = Array.from((destinations || []).map((destination) => destination.id));
  if (ids.includes(requestedId)) return requestedId;
  return ids[0] || '';
}

function createSettingsShellState(definitionLike, requestedId = '') {
  const destinations = buildSettingsDestinations(definitionLike);
  return {
    destinations,
    activeSectionId: resolveActiveSettingsSection(destinations, requestedId)
  };
}

function setActiveSettingsSection(state, requestedId) {
  return {
    ...state,
    activeSectionId: resolveActiveSettingsSection(state?.destinations || [], requestedId)
  };
}

const settingsShellHelpers = {
  applyDiscoveredSystemToDraft,
  buildDestinationWorkspace,
  buildFieldRenderModel,
  buildSettingsDestinations,
  createDiscoveryState,
  createSettingsShellState,
  getDestinationMeta,
  getSettingsSectionFields,
  resolveActiveSettingsSection,
  setActiveSettingsSection,
  shouldOpenSettingsGroup
};

if (typeof globalThis !== 'undefined') {
  globalThis.DVhubSettingsShell = settingsShellHelpers;
}

function shouldRenderHistoryImportPanel(destinationId) {
  return destinationId === 'telemetry';
}

function parseDateTimeLocal(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

function buildHistoryImportRequest(formState) {
  return {
    start: parseDateTimeLocal(formState?.start),
    end: parseDateTimeLocal(formState?.end),
    interval: '15mins'
  };
}

function buildHistoryBackfillRequest() {
  return {
    mode: 'backfill',
    interval: '15mins'
  };
}

function buildHistoryImportActionState({ destinationId, status, form, busy }) {
  const visible = shouldRenderHistoryImportPanel(destinationId);
  if (!visible) return { visible: false, disabled: true, reason: '' };
  if (busy) return { visible: true, disabled: true, reason: 'Import läuft bereits.' };
  if (!status?.enabled) return { visible: true, disabled: true, reason: 'History-Import ist in der Konfiguration deaktiviert.' };
  if (!status?.ready) return { visible: true, disabled: true, reason: 'VRM-Zugang ist noch nicht vollständig konfiguriert.' };
  const payload = buildHistoryImportRequest(form);
  if (!payload.start || !payload.end) return { visible: true, disabled: true, reason: 'Bitte Start und Ende setzen.' };
  if (new Date(payload.end).getTime() <= new Date(payload.start).getTime()) {
    return { visible: true, disabled: true, reason: 'Das Ende muss nach dem Start liegen.' };
  }
  return { visible: true, disabled: false, reason: '' };
}

function buildHistoryBackfillActionState({ destinationId, status, busy }) {
  const visible = shouldRenderHistoryImportPanel(destinationId);
  if (!visible) return { visible: false, disabled: true, reason: '' };
  if (busy) return { visible: true, disabled: true, reason: 'Import läuft bereits.' };
  if (!status?.enabled) return { visible: true, disabled: true, reason: 'History-Import ist in der Konfiguration deaktiviert.' };
  if (!status?.ready) return { visible: true, disabled: true, reason: 'VRM-Zugang ist noch nicht vollständig konfiguriert.' };
  return { visible: true, disabled: false, reason: '' };
}

function formatHistoryImportResult(result) {
  if (!result) return 'Noch kein Import gestartet.';
  if (!result.ok) return `Import fehlgeschlagen: ${result.error}`;
  if (result.windowsVisited != null) {
    return `Backfill gestartet: ${result.importedRows} Werte, ${result.importedWindows}/${result.windowsVisited} Fenster mit Daten, Job ${result.jobId}.`;
  }
  return `Import erfolgreich: ${result.importedRows} Werte, Job ${result.jobId}.`;
}

if (typeof globalThis !== 'undefined') {
  globalThis.DVhubSettingsHistory = {
    buildHistoryImportActionState,
    buildHistoryBackfillActionState,
    buildHistoryBackfillRequest,
    buildHistoryImportRequest,
    shouldRenderHistoryImportPanel
  };
}

function createEmptyPricingPeriod(index = 0) {
  return {
    id: `period-${index + 1}`,
    label: '',
    startDate: '',
    endDate: '',
    mode: 'fixed',
    fixedGrossImportCtKwh: '',
    dynamicComponents: {
      energyMarkupCtKwh: '',
      gridChargesCtKwh: '',
      leviesAndFeesCtKwh: '',
      vatPct: '19'
    }
  };
}

function addPricingPeriod(periods = []) {
  return [...periods, createEmptyPricingPeriod(periods.length)];
}

function removePricingPeriod(periods = [], periodId) {
  return periods.filter((period) => period.id !== periodId);
}

function serializePricingPeriods(periods = []) {
  return periods.map((period, index) => {
    const next = {
      id: period.id || `period-${index + 1}`,
      label: period.label || '',
      startDate: period.startDate || '',
      endDate: period.endDate || '',
      mode: period.mode || 'fixed'
    };
    if (next.mode === 'fixed') {
      next.fixedGrossImportCtKwh = period.fixedGrossImportCtKwh === '' || period.fixedGrossImportCtKwh == null
        ? null
        : Number(period.fixedGrossImportCtKwh);
    } else {
      next.dynamicComponents = {
        energyMarkupCtKwh: Number(period.dynamicComponents?.energyMarkupCtKwh || 0),
        gridChargesCtKwh: Number(period.dynamicComponents?.gridChargesCtKwh || 0),
        leviesAndFeesCtKwh: Number(period.dynamicComponents?.leviesAndFeesCtKwh || 0),
        vatPct: Number(period.dynamicComponents?.vatPct || 0)
      };
    }
    return next;
  });
}

function validatePricingPeriods(periods = []) {
  const messages = [];
  const serialized = serializePricingPeriods(periods);
  const validPeriods = [];

  for (const period of serialized) {
    if (!period.startDate || !period.endDate) {
      messages.push(`Zeitraum ${period.id}: Start- und Enddatum sind Pflicht.`);
      continue;
    }
    if (period.startDate > period.endDate) {
      messages.push(`Zeitraum ${period.id}: Startdatum muss vor dem Enddatum liegen.`);
      continue;
    }
    if (period.mode === 'fixed' && (period.fixedGrossImportCtKwh == null || !Number.isFinite(Number(period.fixedGrossImportCtKwh)))) {
      messages.push(`Zeitraum ${period.id}: Fester Bruttopreis fehlt.`);
      continue;
    }
    if (period.mode === 'dynamic') {
      const components = period.dynamicComponents || {};
      const required = ['energyMarkupCtKwh', 'gridChargesCtKwh', 'leviesAndFeesCtKwh', 'vatPct'];
      if (required.some((key) => !Number.isFinite(Number(components[key])))) {
        messages.push(`Zeitraum ${period.id}: Dynamische Preisbestandteile sind unvollständig.`);
        continue;
      }
    }
    validPeriods.push(period);
  }

  const sorted = [...validPeriods].sort((left, right) => left.startDate.localeCompare(right.startDate));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].startDate <= sorted[index - 1].endDate) {
      messages.push(`Zeitraum ${sorted[index].id}: überschneidet sich mit ${sorted[index - 1].id}.`);
    }
  }

  return {
    valid: messages.length === 0,
    messages,
    periods: serialized
  };
}

if (typeof globalThis !== 'undefined') {
  globalThis.DVhubSettingsPricingPeriods = {
    addPricingPeriod,
    createEmptyPricingPeriod,
    removePricingPeriod,
    serializePricingPeriods,
    validatePricingPeriods
  };
}

function createEmptyPvPlant(index = 0) {
  return {
    id: `pv-plant-${index + 1}`,
    kwp: '',
    commissionedAt: ''
  };
}

function serializeMarketValueMode(value) {
  return value === 'monthly' ? 'monthly' : 'annual';
}

function getDraftMarketValueMode(config) {
  return serializeMarketValueMode(config?.userEnergyPricing?.marketValueMode);
}

function addPvPlant(plants = []) {
  return [...plants, createEmptyPvPlant(plants.length)];
}

function removePvPlant(plants = [], plantId) {
  return plants.filter((plant) => plant.id !== plantId);
}

function serializePvPlants(plants = []) {
  return plants.map((plant) => ({
    kwp: plant.kwp === '' || plant.kwp == null ? null : Number(plant.kwp),
    commissionedAt: plant.commissionedAt || ''
  }));
}

function validatePvPlants(plants = []) {
  const messages = [];
  const serialized = serializePvPlants(plants);

  serialized.forEach((plant, index) => {
    const label = `Anlage ${index + 1}`;
    if (!Number.isFinite(plant.kwp) || Number(plant.kwp) <= 0) {
      messages.push(`${label}: kWp fehlt oder ist ungültig.`);
    }
    if (!plant.commissionedAt) {
      messages.push(`${label}: Inbetriebnahme fehlt.`);
    }
  });

  return {
    valid: messages.length === 0,
    messages,
    plants: serialized
  };
}

function buildMarketPremiumEditorMarkup({ marketValueMode = 'annual', plants = [], validationHtml = '' }) {
  const selectedMode = serializeMarketValueMode(marketValueMode);
  return `
    <div class="settings-subsection-head">
      <p class="card-title">Marktprämie</p>
      <h3>PV-Anlagen</h3>
      <p class="settings-section-meta">${plants.length} konfigurierte Anlagen</p>
      <p class="tools-note">Pflege hier global den Marktwert-Modus sowie pro Anlage nur die installierte Leistung und das Inbetriebnahmedatum. Die offiziellen Referenzwerte werden später daraus abgeleitet.</p>
    </div>
    ${validationHtml}
    <div class="pricing-period-card">
      <div class="pricing-period-grid">
        <label class="settings-field">
          <span class="settings-field-title">Marktwert-Modus</span>
          <select id="marketValueModeSelect">
            <option value="annual"${selectedMode === 'annual' ? ' selected' : ''}>Jahresmarktwert</option>
            <option value="monthly"${selectedMode === 'monthly' ? ' selected' : ''}>Monatsmarktwert</option>
          </select>
          <small class="field-help">Jahresmarktwert nutzt das bisherige Verhalten. Monatsmarktwert erzwingt Monatswerte fuer Monats- und Jahresansichten.</small>
        </label>
      </div>
    </div>
    <div class="settings-inline-actions">
      <button id="addPvPlantBtn" class="btn btn-ghost" type="button">PV-Anlage hinzufügen</button>
    </div>
    <div class="pricing-period-list">
      ${plants.map((plant) => `
        <article class="pricing-period-card" data-pv-plant-id="${plant.id}">
          <div class="pricing-period-grid">
            <label class="settings-field">
              <span class="settings-field-title">Leistung (kWp)</span>
              <input data-pv-plant-id="${plant.id}" data-pv-plant-path="kwp" type="number" step="0.01" min="0" value="${plant.kwp ?? ''}" />
            </label>
            <label class="settings-field">
              <span class="settings-field-title">Inbetriebnahme</span>
              <input data-pv-plant-id="${plant.id}" data-pv-plant-path="commissionedAt" type="date" value="${plant.commissionedAt || ''}" />
            </label>
          </div>
          <div class="settings-inline-actions">
            <button class="btn btn-danger" type="button" data-remove-pv-plant="${plant.id}">Entfernen</button>
          </div>
        </article>
      `).join('')}
    </div>
  `;
}

if (typeof globalThis !== 'undefined') {
  globalThis.DVhubSettingsPvPlants = {
    addPvPlant,
    buildMarketPremiumEditorMarkup,
    createEmptyPvPlant,
    getDraftMarketValueMode,
    removePvPlant,
    serializeMarketValueMode,
    serializePvPlants,
    validatePvPlants
  };
}

function getParts(path) {
  return String(path).split('.').filter(Boolean);
}

function hasPath(obj, path) {
  let cur = obj;
  for (const part of getParts(path)) {
    if (!cur || typeof cur !== 'object' || !(part in cur)) return false;
    cur = cur[part];
  }
  return true;
}

function getPath(obj, path, fallback = undefined) {
  let cur = obj;
  for (const part of getParts(path)) {
    if (!cur || typeof cur !== 'object' || !(part in cur)) return fallback;
    cur = cur[part];
  }
  return cur;
}

function setPath(obj, path, value) {
  const parts = getParts(path);
  let cur = obj;
  while (parts.length > 1) {
    const part = parts.shift();
    if (!cur[part] || typeof cur[part] !== 'object' || Array.isArray(cur[part])) cur[part] = {};
    cur = cur[part];
  }
  cur[parts[0]] = value;
}

function deletePath(obj, path) {
  const parts = getParts(path);
  let cur = obj;
  while (parts.length > 1) {
    const part = parts.shift();
    if (!cur[part] || typeof cur[part] !== 'object') return;
    cur = cur[part];
  }
  delete cur[parts[0]];
}

function fmtTs(ts) {
  return ts ? new Date(ts).toLocaleString('de-DE') : '-';
}

function fieldId(path) {
  return `cfg_${path.replace(/[^a-zA-Z0-9]+/g, '_')}`;
}

function setBanner(message, kind = 'info') {
  const el = document.getElementById('settingsBanner');
  if (!el) return;
  el.textContent = message;
  el.className = `status-banner ${kind}`;
}

function buildMetaText(meta) {
  const parts = [
    `Datei: ${meta.path || '-'}`,
    `Vorhanden: ${meta.exists ? 'Ja' : 'Nein'}`,
    `Gültig: ${meta.valid ? 'Ja' : 'Nein'}`
  ];
  if (meta.parseError) parts.push(`Parse Fehler: ${meta.parseError}`);
  if (Array.isArray(meta.warnings) && meta.warnings.length) parts.push(`Warnungen: ${meta.warnings.length}`);
  parts.push(`Zuletzt geladen: ${fmtTs(Date.now())}`);
  return parts.join(' | ');
}

function renderFieldValue(field) {
  return renderFieldValueFromConfigs(field, {
    draftConfig: currentDraftConfig,
    effectiveConfig: currentEffectiveConfig
  });
}

function renderFieldValueFromConfigs(field, {
  draftConfig = currentDraftConfig,
  effectiveConfig = currentEffectiveConfig
} = {}) {
  const draftDefined = hasPath(draftConfig, field.path);
  const draftValue = draftDefined ? getPath(draftConfig, field.path) : undefined;
  const effectiveValue = getPath(effectiveConfig, field.path);
  const optionalOverride = field.empty === 'delete';

  if (optionalOverride && !draftDefined) {
    return { value: '', inherited: effectiveValue };
  }
  if (draftValue === null || draftValue === undefined) return { value: '', inherited: effectiveValue };
  return { value: draftValue, inherited: draftDefined ? null : effectiveValue };
}

function valuesEqual(left, right) {
  if (left === right) return true;
  if (typeof left === 'boolean' || typeof right === 'boolean') return Boolean(left) === Boolean(right);
  return String(left) === String(right);
}

function getVisibilityValue(path) {
  if (hasPath(currentDraftConfig, path)) return getPath(currentDraftConfig, path);
  return getPath(currentEffectiveConfig, path);
}

function isFieldVisible(field) {
  if (field.visibleWhenPath) {
    const currentValue = getVisibilityValue(field.visibleWhenPath.path);
    if (!valuesEqual(currentValue, field.visibleWhenPath.equals)) return false;
  }

  if (Array.isArray(field.visibleWhenTransport) && field.visibleWhenTransport.length) {
    const transport = getVisibilityValue('victron.transport');
    if (!field.visibleWhenTransport.includes(transport)) return false;
  }

  return true;
}

function fieldAffectsVisibility(path) {
  return (definition?.fields || []).some((field) => (
    field.visibleWhenPath?.path === path
    || (path === 'victron.transport' && Array.isArray(field.visibleWhenTransport) && field.visibleWhenTransport.length)
  ));
}

function createDiscoveryState({
  manufacturer = '',
  systems = [],
  loading = false,
  error = '',
  selectedSystemId = ''
} = {}) {
  const normalizedSystems = Array.isArray(systems) ? systems.filter((system) => system && typeof system === 'object') : [];
  const normalizedError = String(error || '').trim();
  let message = '';
  if (loading) message = 'Suche nach Systemen läuft...';
  else if (normalizedError) message = 'Discovery fehlgeschlagen. Du kannst die Adresse weiter manuell eintragen.';
  else if (normalizedSystems.length) message = `${normalizedSystems.length} System${normalizedSystems.length === 1 ? '' : 'e'} gefunden.`;
  else if (manufacturer) message = 'Kein System gefunden. Du kannst die Adresse weiter manuell eintragen.';
  else message = 'Wähle zuerst einen Hersteller. Du kannst die Adresse weiter manuell eintragen.';

  return {
    manufacturer: String(manufacturer || '').trim(),
    systems: normalizedSystems,
    loading: Boolean(loading),
    error: normalizedError,
    selectedSystemId: selectedSystemId || '',
    disabled: false,
    message
  };
}

function getFieldDiscoveryState(fieldPath) {
  return settingsDiscoveryStates[fieldPath] || createDiscoveryState();
}

function setFieldDiscoveryState(fieldPath, state) {
  settingsDiscoveryStates = {
    ...settingsDiscoveryStates,
    [fieldPath]: state
  };
}

function resolveDiscoveryManufacturer(field, {
  draftConfig = currentDraftConfig,
  effectiveConfig = currentEffectiveConfig
} = {}) {
  const manufacturerPath = field?.discovery?.manufacturerPath;
  if (!manufacturerPath) return '';
  return String(
    getPath(draftConfig, manufacturerPath, '')
    || getPath(effectiveConfig, manufacturerPath, '')
    || ''
  ).trim();
}

function buildFieldRenderModel(field, {
  draftConfig = currentDraftConfig,
  effectiveConfig = currentEffectiveConfig,
  discoveryState = getFieldDiscoveryState(field.path)
} = {}) {
  const valueModel = renderFieldValueFromConfigs(field, { draftConfig, effectiveConfig });
  if (!field?.discovery) {
    return {
      ...valueModel,
      discovery: {
        visible: false,
        manufacturer: '',
        actionLabel: '',
        systems: [],
        loading: false,
        error: '',
        selectedSystemId: '',
        disabled: false,
        message: ''
      }
    };
  }

  const manufacturer = resolveDiscoveryManufacturer(field, { draftConfig, effectiveConfig });
  const nextDiscoveryState = createDiscoveryState({
    ...discoveryState,
    manufacturer
  });

  return {
    ...valueModel,
    discovery: {
      ...nextDiscoveryState,
      visible: true,
      actionLabel: field.discovery.actionLabel || 'Find System IP'
    }
  };
}

function applyDiscoveredSystemToDraft({ draftConfig, fieldPath, selectedSystemId, discoveryState } = {}) {
  const selected = (discoveryState?.systems || []).find((system) => system.id === selectedSystemId);
  const next = clone(draftConfig || {});
  setPath(next, fieldPath, selected?.ip || '');
  return next;
}

function renderField(field) {
  const wrapper = document.createElement('label');
  wrapper.className = 'settings-field';
  wrapper.setAttribute('for', fieldId(field.path));

  const title = document.createElement('span');
  title.className = 'settings-field-title';
  title.textContent = field.label;
  wrapper.appendChild(title);

  const model = buildFieldRenderModel(field);
  const { value, inherited } = model;
  let input;
  if (field.type === 'boolean') {
    wrapper.classList.add('checkbox-field');
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(value);
  } else if (field.type === 'select') {
    input = document.createElement('select');
    for (const optionDef of field.options || []) {
      const option = document.createElement('option');
      option.value = String(optionDef.value);
      option.textContent = optionDef.label;
      input.appendChild(option);
    }
    input.value = String(value);
  } else {
    input = document.createElement('input');
    input.type = field.type === 'number' ? 'number' : 'text';
    if (field.min !== undefined) input.min = field.min;
    if (field.max !== undefined) input.max = field.max;
    if (field.step !== undefined) input.step = field.step;
    input.value = value === null || value === undefined ? '' : String(value);
    if (inherited !== undefined && inherited !== null && field.empty === 'delete') {
      input.placeholder = `Vererbt: ${inherited}`;
    }
  }

  input.id = fieldId(field.path);
  input.dataset.path = field.path;
  input.dataset.type = field.type;
  wrapper.appendChild(input);

  const help = document.createElement('small');
  help.className = 'field-help';
  const helpParts = [];
  if (field.help) helpParts.push(field.help);
  if (field.empty === 'delete' && inherited !== undefined && inherited !== null) helpParts.push(`Aktuell vererbt: ${inherited}`);
  if (field.empty === 'null') helpParts.push('Leer lassen setzt diesen Wert auf "kein Default".');
  help.textContent = helpParts.join(' ');
  wrapper.appendChild(help);

  if (model.discovery.visible) {
    const actions = document.createElement('div');
    actions.className = 'settings-inline-actions settings-discovery-actions';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-secondary';
    button.dataset.discoveryRun = field.path;
    button.disabled = model.discovery.loading || !model.discovery.manufacturer;
    button.textContent = model.discovery.loading ? 'Suche läuft...' : model.discovery.actionLabel;
    actions.appendChild(button);

    const note = document.createElement('small');
    note.className = 'tools-note';
    note.textContent = model.discovery.message;
    actions.appendChild(note);
    wrapper.appendChild(actions);

    if (model.discovery.systems.length) {
      const picker = document.createElement('div');
      picker.className = 'settings-inline-actions settings-discovery-picker';
      for (const system of model.discovery.systems) {
        const applyButton = document.createElement('button');
        applyButton.type = 'button';
        applyButton.className = 'btn btn-ghost';
        applyButton.dataset.discoveryFieldPath = field.path;
        applyButton.dataset.discoverySelectSystem = system.id;
        applyButton.textContent = `${system.label || 'System'} • ${system.host || '-'} • ${system.ip || '-'}`;
        if (system.id === model.discovery.selectedSystemId) {
          applyButton.classList.add('is-active');
        }
        picker.appendChild(applyButton);
      }
      wrapper.appendChild(picker);
    }
  }

  return wrapper;
}

function groupFields(fields) {
  const map = new Map();
  for (const field of fields) {
    const key = field.group || 'main';
    if (!map.has(key)) {
      map.set(key, {
        id: key,
        label: field.groupLabel || key,
        description: field.groupDescription || '',
        fields: []
      });
    }
    map.get(key).fields.push(field);
  }
  return [...map.values()];
}

function shouldOpenSettingsGroup({ sectionIndex = 0, groupIndex = 0 }) {
  return sectionIndex === 0 && groupIndex === 0;
}

function buildDestinationWorkspace(definitionLike, destinationId) {
  const destination = buildSettingsDestinations(definitionLike).find((entry) => entry.id === destinationId);
  if (!destination) return null;

  const sections = (destination.sections || [])
    .map((section, sectionIndex) => {
      const sectionFields = getSettingsSectionFields(definitionLike, section.id);
      if (!sectionFields.length) return null;

      const groups = groupFields(sectionFields).map((group, groupIndex) => ({
        ...group,
        fieldCount: group.fields.length,
        openByDefault: shouldOpenSettingsGroup({ sectionIndex, groupIndex })
      }));

      return {
        ...section,
        fieldCount: sectionFields.length,
        groupCount: groups.length,
        groups
      };
    })
    .filter(Boolean);

  return {
    ...destination,
    sections
  };
}

function buildWorkspaceDefaultCopy(destination) {
  if (!destination) return '';
  if (destination.sections.length === 1 && destination.sections[0].groupCount <= 1) {
    return 'Die relevanten Felder sind direkt sichtbar, ohne weitere Bereiche aufzuklappen.';
  }
  return 'Die erste Gruppe ist geöffnet. Weitere Gruppen bleiben kompakt, bis du sie wirklich brauchst.';
}

function createSummaryCard(title, text) {
  const card = document.createElement('div');
  card.className = 'summary-card';

  const strong = document.createElement('strong');
  strong.textContent = title;
  card.appendChild(strong);

  const body = document.createElement('span');
  body.textContent = text;
  card.appendChild(body);

  return card;
}

function getActiveSettingsDestination() {
  return settingsShellState.destinations.find((destination) => destination.id === settingsShellState.activeSectionId)
    || settingsShellState.destinations[0]
    || null;
}

function buildSectionMeta(destination) {
  if (!destination) return '';
  const fieldText = `${destination.fieldCount} Felder`;
  if (destination.sectionCount > 1) return `${fieldText} in ${destination.sectionCount} Bereichen`;
  return `${fieldText} in ${destination.groupCount} Gruppen`;
}

function renderSidebarNavigation() {
  const navTree = document.getElementById('settingsNavTree');
  if (!navTree) return;

  navTree.innerHTML = '';
  for (const destination of settingsShellState.destinations) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'app-nav-subitem';
    button.dataset.settingsTarget = destination.id;
    const isActive = destination.id === settingsShellState.activeSectionId;
    if (isActive) button.classList.add('is-active');
    button.setAttribute('aria-current', isActive ? 'page' : 'false');
    button.innerHTML = `
      <span class="app-nav-subitem-label">${destination.label}</span>
      <small class="app-nav-subitem-copy">${destination.description || buildSectionMeta(destination)}</small>
    `;
    navTree.appendChild(button);
  }
}

function renderSectionWorkspace(sectionId) {
  const mount = document.getElementById('settingsSections');
  if (!mount) return;
  mount.innerHTML = '';

  const destination = buildDestinationWorkspace(definition, sectionId);
  const destinationMeta = getDestinationMeta(definition, sectionId);
  if (!destination || !destination.sections.length) return;

  const panel = document.createElement('section');
  panel.className = 'panel reveal settings-panel';

  const header = document.createElement('div');
  header.className = 'panel-head settings-panel-head';
  header.innerHTML = `
    <div>
      <p class="card-title">Aktiver Bereich</p>
      <h2 class="section-title">${destination.label}</h2>
    </div>
    <div class="settings-panel-meta">
      <strong>${buildSectionMeta(destination)}</strong>
      <span>${destination.sections.map((section) => section.label).join(' • ')}</span>
    </div>
  `;
  panel.appendChild(header);

  const intro = document.createElement('p');
  intro.className = 'tools-note';
  intro.textContent = destinationMeta?.intro || destination.intro || destination.description || '';
  panel.appendChild(intro);

  for (const section of destination.sections) {
    const sectionShell = document.createElement('section');
    sectionShell.className = 'settings-subsection';

    const sectionHead = document.createElement('div');
    sectionHead.className = 'settings-subsection-head';
    sectionHead.innerHTML = `
      <p class="card-title">Bereich</p>
      <h3>${section.label}</h3>
      <p class="settings-section-meta">${section.fieldCount} Felder in ${section.groupCount} Gruppen</p>
      <p class="tools-note">${section.description || ''}</p>
    `;
    sectionShell.appendChild(sectionHead);

    const groupList = document.createElement('div');
    groupList.className = 'settings-group-list';

    for (const group of section.groups) {
      const visibleFields = group.fields.filter((field) => field.type !== 'array' && isFieldVisible(field));
      if (!visibleFields.length) continue;

      const details = document.createElement('details');
      details.className = 'settings-group';
      details.open = group.openByDefault;

      const summary = document.createElement('summary');
      summary.innerHTML = `<span>${group.label}</span><small>${group.description || ''}</small>`;
      details.appendChild(summary);

      const grid = document.createElement('div');
      grid.className = 'settings-fields';
      for (const field of visibleFields) grid.appendChild(renderField(field));
      details.appendChild(grid);
      groupList.appendChild(details);
    }

    sectionShell.appendChild(groupList);
    if (section.id === 'pricing') {
      sectionShell.appendChild(renderPvPlantsEditor());
      sectionShell.appendChild(renderPricingPeriodsEditor());
    }
    panel.appendChild(sectionShell);
  }

  if (shouldRenderHistoryImportPanel(sectionId)) {
    panel.appendChild(renderHistoryImportPanel(sectionId));
  }

  mount.appendChild(panel);
}

function buildHistoryImportSummary(status) {
  if (!status) return 'Status wird geladen...';
  if (!status.enabled) return 'VRM-Backfill ist derzeit deaktiviert.';
  if (!status.ready) return 'VRM-Zugang ist noch nicht vollständig konfiguriert.';
  return `VRM verbunden für Portal ${status.vrmPortalId || '-'}. Historischer Nachimport ist bereit.`;
}

function renderHistoryImportPanel(destinationId) {
  const panel = document.createElement('section');
  panel.className = 'settings-subsection settings-history-subsection';

  const head = document.createElement('div');
  head.className = 'settings-subsection-head';
  head.innerHTML = `
    <p class="card-title">Historie</p>
    <h3>VRM Backfill</h3>
    <p class="settings-section-meta">Historische Nachimporte werden bewusst nur über VRM unterstützt.</p>
    <p class="tools-note">GX/Cerbo bleibt Live-Quelle. Für Historie und Lückenfüllung nutzt DVhub den VRM-Zugang aus den Telemetrie-Einstellungen.</p>
  `;
  panel.appendChild(head);

  const statusBanner = document.createElement('div');
  statusBanner.className = `status-banner ${currentHistoryImportStatus?.ready ? 'success' : 'warn'}`;
  statusBanner.textContent = buildHistoryImportSummary(currentHistoryImportStatus);
  panel.appendChild(statusBanner);

  const summary = document.createElement('div');
  summary.className = 'settings-workspace-summary';
  summary.appendChild(createSummaryCard('Quelle', 'VRM Portal'));
  summary.appendChild(createSummaryCard('Portal ID', currentHistoryImportStatus?.vrmPortalId || '-'));
  summary.appendChild(createSummaryCard('Status', currentHistoryImportStatus?.ready ? 'Import bereit' : 'Konfiguration unvollständig'));
  panel.appendChild(summary);

  const grid = document.createElement('div');
  grid.className = 'settings-fields compact';
  grid.innerHTML = `
    <label class="settings-field" for="historyImportStart">
      <span class="settings-field-title">Von</span>
      <input id="historyImportStart" type="datetime-local" value="${historyImportFormState.start || ''}" />
      <small class="field-help">Startzeit des VRM-Historienimports.</small>
    </label>
    <label class="settings-field" for="historyImportEnd">
      <span class="settings-field-title">Bis</span>
      <input id="historyImportEnd" type="datetime-local" value="${historyImportFormState.end || ''}" />
      <small class="field-help">Endzeit des VRM-Historienimports.</small>
    </label>
    <label class="settings-field">
      <span class="settings-field-title">Intervall</span>
      <input type="text" value="15 Minuten" readonly />
      <small class="field-help">VRM-Stats werden fuer den Abgleich immer in 15-Minuten-Aufloesung importiert.</small>
    </label>
  `;
  panel.appendChild(grid);

  const actionState = buildHistoryImportActionState({
    destinationId,
    status: currentHistoryImportStatus,
    form: historyImportFormState,
    busy: historyImportBusy
  });
  const backfillState = buildHistoryBackfillActionState({
    destinationId,
    status: currentHistoryImportStatus,
    busy: historyImportBusy
  });

  const actions = document.createElement('div');
  actions.className = 'settings-inline-actions';
  const importButton = document.createElement('button');
  importButton.id = 'historyImportBtn';
  importButton.type = 'button';
  importButton.className = 'btn btn-primary';
  importButton.disabled = actionState.disabled;
  importButton.textContent = historyImportBusy ? 'VRM-Job läuft...' : 'VRM-Historie importieren';
  actions.appendChild(importButton);

  const backfillButton = document.createElement('button');
  backfillButton.id = 'historyBackfillBtn';
  backfillButton.type = 'button';
  backfillButton.className = 'btn btn-secondary';
  backfillButton.disabled = backfillState.disabled;
  backfillButton.textContent = historyImportBusy ? 'VRM-Job läuft...' : 'VRM-Backfill starten';
  actions.appendChild(backfillButton);

  const note = document.createElement('small');
  note.className = 'tools-note';
  note.textContent = actionState.reason || backfillState.reason || 'Importiert einen expliziten Zeitraum oder startet einen automatischen VRM-Backfill bis zur ersten leeren Historie.';
  actions.appendChild(note);
  panel.appendChild(actions);

  const result = document.createElement('div');
  result.id = 'historyImportResult';
  result.className = `status-banner ${currentHistoryImportResult?.ok ? 'success' : currentHistoryImportResult?.error ? 'error' : 'info'}`;
  result.textContent = formatHistoryImportResult(currentHistoryImportResult);
  panel.appendChild(result);

  bindHistoryImportControls(panel);
  return panel;
}

function syncHistoryImportForm(panel) {
  historyImportFormState = {
    start: panel.querySelector('#historyImportStart')?.value || '',
    end: panel.querySelector('#historyImportEnd')?.value || ''
  };
}

function updatePricingPeriodField(periodId, path, value) {
  pricingPeriodsDraft = pricingPeriodsDraft.map((period) => {
    if (period.id !== periodId) return period;
    const next = clone(period);
    setPath(next, path, value);
    return next;
  });
}

function updatePvPlantField(plantId, path, value) {
  pvPlantsDraft = pvPlantsDraft.map((plant) => {
    if (plant.id !== plantId) return plant;
    const next = clone(plant);
    setPath(next, path, value);
    return next;
  });
}

function renderPvPlantsEditor() {
  const section = document.createElement('section');
  section.className = 'settings-pricing-periods';
  const validation = pvPlantsValidation.length
    ? `<div class="status-banner error">${pvPlantsValidation.map((message) => `<div>${message}</div>`).join('')}</div>`
    : '<div class="status-banner info">Mehrere PV-Anlagen werden über Leistung und Inbetriebnahme für die jährliche Marktprämie gewichtet.</div>';
  section.innerHTML = buildMarketPremiumEditorMarkup({
    marketValueMode: marketValueModeDraft,
    plants: pvPlantsDraft,
    validationHtml: validation
  });

  section.querySelector('#marketValueModeSelect')?.addEventListener('change', (event) => {
    marketValueModeDraft = serializeMarketValueMode(event.target.value);
  });

  section.querySelector('#addPvPlantBtn')?.addEventListener('click', () => {
    pvPlantsDraft = addPvPlant(pvPlantsDraft);
    pvPlantsValidation = [];
    renderActiveSettingsDestination();
  });

  section.querySelectorAll('[data-remove-pv-plant]').forEach((button) => {
    button.addEventListener('click', () => {
      pvPlantsDraft = removePvPlant(pvPlantsDraft, button.dataset.removePvPlant);
      pvPlantsValidation = [];
      renderActiveSettingsDestination();
    });
  });

  section.querySelectorAll('[data-pv-plant-id][data-pv-plant-path]').forEach((input) => {
    input.addEventListener('change', () => {
      updatePvPlantField(input.dataset.pvPlantId, input.dataset.pvPlantPath, input.value);
      pvPlantsValidation = [];
      renderActiveSettingsDestination();
    });
  });

  return section;
}

function renderPricingPeriodsEditor() {
  const section = document.createElement('section');
  section.className = 'settings-pricing-periods';
  const validation = pricingPeriodsValidation.length
    ? `<div class="status-banner error">${pricingPeriodsValidation.map((message) => `<div>${message}</div>`).join('')}</div>`
    : '<div class="status-banner info">Tarifzeiträume werden tagesgenau auf die Historienberechnung angewendet.</div>';

  section.innerHTML = `
    <div class="settings-subsection-head">
      <p class="card-title">Bezugspreise nach Zeitraum</p>
      <h3>Tarifzeiträume</h3>
      <p class="settings-section-meta">${pricingPeriodsDraft.length} definierte Zeiträume</p>
      <p class="tools-note">Definiere hier fixe oder dynamische Tarife pro Zeitraum. Überlappungen werden vor dem Speichern blockiert.</p>
    </div>
    ${validation}
    <div class="settings-inline-actions">
      <button id="addPricingPeriodBtn" class="btn btn-ghost" type="button">Zeitraum hinzufügen</button>
    </div>
    <div class="pricing-period-list">
      ${pricingPeriodsDraft.map((period) => `
        <article class="pricing-period-card" data-period-id="${period.id}">
          <div class="pricing-period-grid">
            <label class="settings-field">
              <span class="settings-field-title">Bezeichnung</span>
              <input data-period-id="${period.id}" data-period-path="label" type="text" value="${period.label || ''}" />
            </label>
            <label class="settings-field">
              <span class="settings-field-title">Start</span>
              <input data-period-id="${period.id}" data-period-path="startDate" type="date" value="${period.startDate || ''}" />
            </label>
            <label class="settings-field">
              <span class="settings-field-title">Ende</span>
              <input data-period-id="${period.id}" data-period-path="endDate" type="date" value="${period.endDate || ''}" />
            </label>
            <label class="settings-field">
              <span class="settings-field-title">Modus</span>
              <select data-period-id="${period.id}" data-period-path="mode">
                <option value="fixed"${period.mode === 'fixed' ? ' selected' : ''}>Fixpreis</option>
                <option value="dynamic"${period.mode === 'dynamic' ? ' selected' : ''}>Dynamisch</option>
              </select>
            </label>
            ${period.mode === 'fixed' ? `
              <label class="settings-field">
                <span class="settings-field-title">Bruttopreis (ct/kWh)</span>
                <input data-period-id="${period.id}" data-period-path="fixedGrossImportCtKwh" type="number" step="0.01" value="${period.fixedGrossImportCtKwh ?? ''}" />
              </label>
            ` : `
              <label class="settings-field">
                <span class="settings-field-title">Energie-Aufschlag</span>
                <input data-period-id="${period.id}" data-period-path="dynamicComponents.energyMarkupCtKwh" type="number" step="0.01" value="${period.dynamicComponents?.energyMarkupCtKwh ?? ''}" />
              </label>
              <label class="settings-field">
                <span class="settings-field-title">Netzentgelte</span>
                <input data-period-id="${period.id}" data-period-path="dynamicComponents.gridChargesCtKwh" type="number" step="0.01" value="${period.dynamicComponents?.gridChargesCtKwh ?? ''}" />
              </label>
              <label class="settings-field">
                <span class="settings-field-title">Umlagen &amp; Abgaben</span>
                <input data-period-id="${period.id}" data-period-path="dynamicComponents.leviesAndFeesCtKwh" type="number" step="0.01" value="${period.dynamicComponents?.leviesAndFeesCtKwh ?? ''}" />
              </label>
              <label class="settings-field">
                <span class="settings-field-title">MwSt (%)</span>
                <input data-period-id="${period.id}" data-period-path="dynamicComponents.vatPct" type="number" step="0.01" value="${period.dynamicComponents?.vatPct ?? ''}" />
              </label>
            `}
          </div>
          <div class="settings-inline-actions">
            <button class="btn btn-danger" type="button" data-remove-period="${period.id}">Entfernen</button>
          </div>
        </article>
      `).join('')}
    </div>
  `;

  section.querySelector('#addPricingPeriodBtn')?.addEventListener('click', () => {
    pricingPeriodsDraft = addPricingPeriod(pricingPeriodsDraft);
    pricingPeriodsValidation = [];
    renderActiveSettingsDestination();
  });

  section.querySelectorAll('[data-remove-period]').forEach((button) => {
    button.addEventListener('click', () => {
      pricingPeriodsDraft = removePricingPeriod(pricingPeriodsDraft, button.dataset.removePeriod);
      pricingPeriodsValidation = [];
      renderActiveSettingsDestination();
    });
  });

  section.querySelectorAll('[data-period-id][data-period-path]').forEach((input) => {
    input.addEventListener('change', () => {
      updatePricingPeriodField(input.dataset.periodId, input.dataset.periodPath, input.value);
      pricingPeriodsValidation = [];
      renderActiveSettingsDestination();
    });
  });

  return section;
}

function bindHistoryImportControls(panel) {
  const handleChange = () => {
    syncHistoryImportForm(panel);
    renderActiveSettingsDestination();
  };

  panel.querySelector('#historyImportStart')?.addEventListener('change', handleChange);
  panel.querySelector('#historyImportEnd')?.addEventListener('change', handleChange);
  panel.querySelector('#historyImportBtn')?.addEventListener('click', () => {
    triggerHistoryImport().catch((error) => {
      currentHistoryImportResult = { ok: false, error: error.message };
      historyImportBusy = false;
      renderActiveSettingsDestination();
    });
  });
  panel.querySelector('#historyBackfillBtn')?.addEventListener('click', () => {
    triggerHistoryBackfill().catch((error) => {
      currentHistoryImportResult = { ok: false, error: error.message };
      historyImportBusy = false;
      renderActiveSettingsDestination();
    });
  });
}

function renderActiveSettingsDestination() {
  const activeDestination = getActiveSettingsDestination();
  if (!activeDestination) return;
  renderSectionWorkspace(activeDestination.id);
}

function renderSettingsShell() {
  settingsShellState = createSettingsShellState(definition, settingsShellState.activeSectionId);
  renderSidebarNavigation();
  renderActiveSettingsDestination();
}

function syncRenderedFieldsToDraft() {
  const next = clone(currentDraftConfig || {});
  for (const field of definition?.fields || []) {
    const input = document.getElementById(fieldId(field.path));
    if (!input) continue;
    const parsed = parseFieldInput(field);
    if (parsed && parsed.action === 'delete') deletePath(next, field.path);
    else setPath(next, field.path, parsed);
  }
  currentDraftConfig = next;
  return next;
}

function activateSettingsDestination(sectionId) {
  syncRenderedFieldsToDraft();
  settingsShellState = setActiveSettingsSection(settingsShellState, sectionId);
  renderSidebarNavigation();
  renderActiveSettingsDestination();
}

function parseFieldInput(field) {
  const input = document.getElementById(fieldId(field.path));
  if (!input) return undefined;

  if (field.type === 'boolean') return input.checked;

  const rawValue = String(input.value ?? '').trim();
  if (!rawValue) {
    if (field.empty === 'delete') return { action: 'delete' };
    if (field.empty === 'null') return null;
    return '';
  }

  if (field.type === 'number') return Number(rawValue);
  if (field.type === 'select') {
    const allNumeric = (field.options || []).every((option) => typeof option.value === 'number');
    return allNumeric ? Number(rawValue) : rawValue;
  }
  return rawValue;
}

function collectConfigFromForm() {
  syncRenderedFieldsToDraft();
  const next = clone(currentDraftConfig || {});
  next.userEnergyPricing = next.userEnergyPricing || {};
  next.userEnergyPricing.marketValueMode = serializeMarketValueMode(marketValueModeDraft);
  next.userEnergyPricing.periods = serializePricingPeriods(pricingPeriodsDraft);
  next.userEnergyPricing.pvPlants = serializePvPlants(pvPlantsDraft);
  return next;
}

function applyConfigPayload(payload) {
  definition = payload.definition || definition;
  currentRawConfig = payload.config || {};
  currentDraftConfig = clone(currentRawConfig);
  currentEffectiveConfig = payload.effectiveConfig || {};
  currentMeta = payload.meta || {};
  settingsDiscoveryStates = {};
  pricingPeriodsDraft = clone(currentRawConfig?.userEnergyPricing?.periods || []);
  marketValueModeDraft = getDraftMarketValueMode(currentRawConfig);
  pvPlantsDraft = (currentRawConfig?.userEnergyPricing?.pvPlants || []).map((plant, index) => ({
    ...createEmptyPvPlant(index),
    kwp: plant?.kwp ?? '',
    commissionedAt: plant?.commissionedAt || ''
  }));
  pricingPeriodsValidation = [];
  pvPlantsValidation = [];
  settingsShellState = createSettingsShellState(definition);
  setStoredApiToken(currentEffectiveConfig.apiToken || '');
  document.getElementById('configMeta').textContent = buildMetaText(currentMeta);
  renderSettingsShell();
}

function setHealthBanner(message, kind = 'info') {
  const el = document.getElementById('healthBanner');
  if (!el) return;
  el.textContent = message;
  el.className = `status-banner ${kind}`;
}

function renderHealth(payload) {
  currentHealth = payload;
  const mount = document.getElementById('healthChecks');
  if (!mount) return;
  mount.innerHTML = '';
  const checks = Array.isArray(payload.checks) ? payload.checks : [];
  for (const check of checks) {
    const card = document.createElement('div');
    card.className = 'summary-card';
    const strong = document.createElement('strong');
    strong.textContent = `${check.ok ? 'OK' : 'Check'}: ${check.label}`;
    const text = document.createElement('span');
    text.textContent = check.detail || '-';
    card.appendChild(strong);
    card.appendChild(text);
    mount.appendChild(card);
  }

  const service = payload.service || {};
  const serviceMeta = document.getElementById('serviceMeta');
  if (serviceMeta) {
    serviceMeta.textContent =
      `Service: ${service.name || '-'} | Status: ${service.status || '-'} | Runtime: ${payload.runtime?.node || '-'} | Geprueft: ${fmtTs(payload.checkedAt)}`;
  }

  const restartButton = document.getElementById('restartServiceBtn');
  if (restartButton) restartButton.disabled = !(service.enabled && service.status !== 'unavailable');

  if (!service.enabled) setHealthBanner('Restart-Aktionen sind deaktiviert. Aktivierung erfolgt über den Installer bzw. ENV-Variablen.', 'warn');
  else if (service.status === 'unavailable') setHealthBanner(`Service-Check fehlgeschlagen: ${service.detail || 'systemctl nicht erreichbar'}`, 'error');
  else setHealthBanner(`Service ${service.name} ist erreichbar. Status: ${service.status}.`, 'success');
}

async function loadConfig() {
  const res = await apiFetch('/api/config');
  const payload = await res.json();
  if (!res.ok || !payload.ok) {
    setBanner(`Konfiguration konnte nicht geladen werden: ${payload.error || res.status}`, 'error');
    return;
  }
  applyConfigPayload(payload);
  if (currentMeta.needsSetup) setBanner('Es wurde noch keine gültige Config gefunden. Du kannst sie hier direkt anlegen oder den Setup-Assistenten nutzen.', 'warn');
  else setBanner('Konfiguration geladen. Änderungen können jetzt im Menü bearbeitet werden.', 'success');
}

async function loadHealth() {
  const res = await apiFetch('/api/admin/health');
  const payload = await res.json();
  if (!res.ok || !payload.ok) {
    setHealthBanner(`Health-Status konnte nicht geladen werden: ${payload.error || res.status}`, 'error');
    return;
  }
  renderHealth(payload);
}

async function loadHistoryImportStatus() {
  const res = await apiFetch('/api/history/import/status');
  const payload = await res.json();
  if (!res.ok || !payload.ok) {
    currentHistoryImportStatus = {
      enabled: false,
      ready: false,
      provider: 'vrm',
      mode: 'vrm_only',
      vrmPortalId: ''
    };
    currentHistoryImportResult = { ok: false, error: payload.error || String(res.status) };
    return;
  }
  currentHistoryImportStatus = payload.historyImport || null;
}

async function saveConfig(config, source = 'settings') {
  const res = await apiFetch(source === 'import' ? '/api/config/import' : '/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config })
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) {
    setBanner(`Speichern fehlgeschlagen: ${payload.error || res.status}`, 'error');
    return false;
  }

  applyConfigPayload({
    ok: true,
    definition,
    config: payload.config,
    effectiveConfig: payload.effectiveConfig,
    meta: payload.meta
  });

  const restartNote = payload.restartRequired
    ? ` Neustart empfohlen für: ${payload.restartRequiredPaths.join(', ')}`
    : '';
  setBanner(`Konfiguration gespeichert.${restartNote}`, payload.restartRequired ? 'warn' : 'success');
  await loadHistoryImportStatus();
  renderActiveSettingsDestination();
  return true;
}

async function triggerHistoryImport() {
  historyImportBusy = true;
  renderActiveSettingsDestination();
  const payload = buildHistoryImportRequest(historyImportFormState);
  const res = await apiFetch('/api/history/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await res.json();
  currentHistoryImportResult = body;
  historyImportBusy = false;
  await loadHistoryImportStatus();
  renderActiveSettingsDestination();
  if (!res.ok || !body.ok) throw new Error(body.error || String(res.status));
}

async function triggerHistoryBackfill() {
  historyImportBusy = true;
  renderActiveSettingsDestination();
  const payload = buildHistoryBackfillRequest();
  const res = await apiFetch('/api/history/backfill/vrm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await res.json();
  currentHistoryImportResult = body;
  historyImportBusy = false;
  await loadHistoryImportStatus();
  renderActiveSettingsDestination();
  if (!res.ok || !body.ok) throw new Error(body.error || String(res.status));
}

async function triggerFieldDiscovery(fieldPath) {
  const field = (definition?.fields || []).find((entry) => entry.path === fieldPath);
  if (!field?.discovery) return;
  const manufacturer = resolveDiscoveryManufacturer(field);
  if (!manufacturer) {
    setFieldDiscoveryState(fieldPath, createDiscoveryState({
      manufacturer: '',
      error: 'manufacturer required'
    }));
    renderActiveSettingsDestination();
    return;
  }

  setFieldDiscoveryState(fieldPath, createDiscoveryState({
    manufacturer,
    loading: true
  }));
  renderActiveSettingsDestination();

  try {
    const res = await apiFetch(`/api/discovery/systems?manufacturer=${encodeURIComponent(manufacturer)}`);
    const payload = await res.json();
    if (!res.ok || !payload.ok) {
      throw new Error(payload.error || String(res.status));
    }
    setFieldDiscoveryState(fieldPath, createDiscoveryState({
      manufacturer,
      systems: payload.systems || []
    }));
  } catch (error) {
    setFieldDiscoveryState(fieldPath, createDiscoveryState({
      manufacturer,
      error: error.message || 'Discovery failed'
    }));
  }

  renderActiveSettingsDestination();
}

function applyFieldDiscoverySelection(fieldPath, selectedSystemId) {
  const discoveryState = getFieldDiscoveryState(fieldPath);
  currentDraftConfig = applyDiscoveredSystemToDraft({
    draftConfig: currentDraftConfig,
    fieldPath,
    selectedSystemId,
    discoveryState
  });
  setFieldDiscoveryState(fieldPath, createDiscoveryState({
    ...discoveryState,
    selectedSystemId
  }));
  renderActiveSettingsDestination();
}

async function saveCurrentForm() {
  const config = collectConfigFromForm();
  const pricingValidation = validatePricingPeriods(pricingPeriodsDraft);
  const pvValidation = validatePvPlants(pvPlantsDraft);
  pricingPeriodsValidation = pricingValidation.messages;
  pvPlantsValidation = pvValidation.messages;
  if (!pricingValidation.valid || !pvValidation.valid) {
    renderActiveSettingsDestination();
    setBanner(`Speichern blockiert: ${pricingValidation.messages[0] || pvValidation.messages[0]}`, 'error');
    return;
  }
  await saveConfig(config, 'settings');
}

async function importConfigFromFile(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    await saveConfig(parsed, 'import');
  } catch (error) {
    setBanner(`Import fehlgeschlagen: ${error.message}`, 'error');
  }
}

function exportConfig() {
  window.location.href = buildApiUrl('/api/config/export');
}

async function restartService() {
  const res = await apiFetch('/api/admin/service/restart', { method: 'POST' });
  const payload = await res.json();
  if (!res.ok || !payload.ok) {
    setHealthBanner(`Restart fehlgeschlagen: ${payload.error || res.status}`, 'error');
    return;
  }
  setHealthBanner('Restart wurde angefordert. Die Seite versucht sich gleich neu zu verbinden.', 'warn');
  window.setTimeout(() => {
    window.location.reload();
  }, 8000);
}

function initSettingsPage() {
  document.getElementById('settingsSections')?.addEventListener('change', (event) => {
    const input = event.target;
    if (!input?.dataset?.path) return;
    syncRenderedFieldsToDraft();
    if (input.dataset.path === 'manufacturer') settingsDiscoveryStates = {};
    if (fieldAffectsVisibility(input.dataset.path)) renderActiveSettingsDestination();
  });

  document.getElementById('settingsSections')?.addEventListener('click', (event) => {
    const runButton = event.target.closest('[data-discovery-run]');
    if (runButton) {
      triggerFieldDiscovery(runButton.dataset.discoveryRun).catch((error) => {
        setBanner(`Discovery fehlgeschlagen: ${error.message}`, 'error');
      });
      return;
    }

    const selectionButton = event.target.closest('[data-discovery-select-system]');
    if (!selectionButton) return;
    applyFieldDiscoverySelection(
      selectionButton.dataset.discoveryFieldPath,
      selectionButton.dataset.discoverySelectSystem
    );
  });

  document.getElementById('settingsNavTree')?.addEventListener('click', (event) => {
    const target = event.target.closest('[data-settings-target]');
    if (!target) return;
    activateSettingsDestination(target.dataset.settingsTarget);
  });

  document.getElementById('reloadConfigBtn')?.addEventListener('click', () => loadConfig().catch((error) => {
    setBanner(`Neu laden fehlgeschlagen: ${error.message}`, 'error');
  }));

  document.getElementById('saveConfigBtn')?.addEventListener('click', () => saveCurrentForm().catch((error) => {
    setBanner(`Speichern fehlgeschlagen: ${error.message}`, 'error');
  }));

  document.getElementById('exportConfigBtn')?.addEventListener('click', exportConfig);
  document.getElementById('refreshHealthBtn')?.addEventListener('click', () => loadHealth().catch((error) => {
    setHealthBanner(`Health-Status konnte nicht geladen werden: ${error.message}`, 'error');
  }));
  document.getElementById('restartServiceBtn')?.addEventListener('click', () => restartService().catch((error) => {
    setHealthBanner(`Restart fehlgeschlagen: ${error.message}`, 'error');
  }));

  document.getElementById('importConfigBtn')?.addEventListener('click', () => {
    document.getElementById('importConfigFile')?.click();
  });

  document.getElementById('importConfigFile')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    await importConfigFromFile(file);
    event.target.value = '';
  });

  window.addEventListener('dvhub:unauthorized', () => {
    setBanner('API-Zugriff abgelehnt. Falls ein API-Token gesetzt ist, die Seite mit ?token=DEIN_TOKEN öffnen oder das Token neu speichern.', 'error');
  });

  loadConfig().catch((error) => {
    setBanner(`Konfiguration konnte nicht geladen werden: ${error.message}`, 'error');
  });
  loadHistoryImportStatus().then(() => {
    renderActiveSettingsDestination();
  }).catch((error) => {
    currentHistoryImportResult = { ok: false, error: error.message };
    renderActiveSettingsDestination();
  });
}

if (typeof document !== 'undefined') {
  initSettingsPage();
}
