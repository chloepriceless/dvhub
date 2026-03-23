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

const GROUP_ACCENTS = {
  connection: 'green', transport: 'green', victron: 'green',
  modbus: 'yellow', dvProxy: 'yellow', dv: 'yellow', control: 'yellow',
  schedule: 'green', automation: 'yellow', dvControl: 'blue',
  location: 'blue', standort: 'blue',
  telemetry: 'cyan', vrm: 'cyan',
  webserver: 'purple', http: 'purple', api: 'purple',
  mqtt: 'orange',
  epex: 'green', pricing: 'yellow', pvPlants: 'blue'
};

function getGroupAccent(section) {
  return GROUP_ACCENTS[section.id] || GROUP_ACCENTS[section.destination] || 'green';
}

function createConfigGroup(label, accent) {
  const group = document.createElement('div');
  group.className = 'config-group';
  if (accent) group.dataset.accent = accent;
  const kicker = document.createElement('div');
  kicker.className = 'config-group-kicker';
  kicker.style.color = `var(--flow-${accent || 'green'})`;
  kicker.textContent = label;
  group.appendChild(kicker);
  return group;
}

function createConfigRow(label, inputEl, opts) {
  const row = document.createElement('div');
  row.className = 'config-row';
  const labelSpan = document.createElement('span');
  labelSpan.className = 'config-row-label';
  labelSpan.textContent = label;
  if (opts?.required) {
    const req = document.createElement('span');
    req.className = 'config-required';
    req.textContent = '*';
    labelSpan.appendChild(req);
  }
  row.appendChild(labelSpan);
  if (typeof inputEl === 'string') {
    const val = document.createElement('strong');
    val.className = 'config-row-value';
    val.textContent = inputEl;
    row.appendChild(val);
  } else {
    row.appendChild(inputEl);
  }
  return row;
}

function createConfigInput(field, value) {
  let input;
  if (field.type === 'boolean') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'config-checkbox';
    input.checked = Boolean(value);
  } else if (field.type === 'select') {
    input = document.createElement('select');
    input.className = 'config-select';
    for (const opt of field.options || []) {
      const option = document.createElement('option');
      option.value = String(opt.value);
      option.textContent = opt.label;
      input.appendChild(option);
    }
    input.value = String(value);
  } else if (field.type === 'dynamicSelect') {
    input = document.createElement('select');
    input.className = 'config-select';
    const placeholder = document.createElement('option');
    placeholder.value = String(value || '');
    placeholder.textContent = value ? String(value) : 'Laden...';
    input.appendChild(placeholder);
    if (field.dynamicOptionsUrl) {
      apiFetch(field.dynamicOptionsUrl).then(data => {
        input.innerHTML = '';
        for (const z of (data?.zones || [])) {
          const opt = document.createElement('option');
          opt.value = z.zone;
          opt.textContent = z.zone;
          input.appendChild(opt);
        }
        input.value = String(value || 'DE-LU');
      }).catch(() => { placeholder.textContent = value || 'Fehler'; });
    }
  } else {
    input = document.createElement('input');
    input.type = field.type === 'number' ? 'number' : (field.type === 'time' ? 'time' : 'text');
    input.className = 'config-input';
    if (field.min !== undefined) input.min = field.min;
    if (field.max !== undefined) input.max = field.max;
    if (field.step !== undefined) input.step = field.step;
    input.value = value === null || value === undefined ? '' : String(value);
    const valStr = String(input.value);
    const charW = field.type === 'number' ? 10 : 8;
    input.style.width = `${Math.max(field.type === 'number' ? 80 : 120, valStr.length * charW + 30)}px`;
  }
  input.id = fieldId(field.path);
  input.dataset.path = field.path;
  input.dataset.type = field.type;
  return input;
}

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

// buildDisclosureSummaryMarkup removed — replaced by config-group cards

const settingsShellHelpers = {
  applyDiscoveredSystemToDraft,
  buildDestinationWorkspace,
  buildFieldRenderModel,
  buildSettingsDestinations,
  createDiscoveryState,
  createSettingsShellState,
  formatDiscoveredSystemOption,
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
    <div style="margin-bottom:8px;">
      <p class="card-kicker">Marktprämie</p>
      <h3 class="section-title" style="font-size:1rem;">PV-Anlagen</h3>
      <p class="meta">${plants.length} konfigurierte Anlagen · Leistung und Inbetriebnahmedatum pflegen.</p>
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
  setPath(next, fieldPath, selected?.ipv4 || selected?.ip || selected?.ipv6 || '');
  return next;
}

function formatDiscoveredSystemOption(system = {}) {
  const parts = [system.label || 'System', system.host || '-'];
  if (system.ipv4) parts.push(`IPv4: ${system.ipv4}`);
  if (system.ipv6) parts.push(`IPv6: ${system.ipv6}`);
  if (!system.ipv4 && !system.ipv6 && system.ip) parts.push(system.ip);
  return parts.join(' • ');
}

// renderField removed — replaced by createConfigInput + createConfigRow

/* ---------- OpenStreetMap location picker modal ---------- */
function openLocationPicker(locationBasePath) {
  const latPath = locationBasePath + '.latitude';
  const lonPath = locationBasePath + '.longitude';
  const latInput = document.querySelector(`[data-path="${latPath}"]`);
  const lonInput = document.querySelector(`[data-path="${lonPath}"]`);
  const currentLat = parseFloat(latInput?.value) || 51.0;
  const currentLon = parseFloat(lonInput?.value) || 10.0;

  // Create modal overlay
  const overlay = document.createElement('div');
  overlay.className = 'location-picker-overlay';
  overlay.innerHTML = `
    <div class="location-picker-modal">
      <div class="location-picker-header">
        <strong>Standort auf Karte w\u00e4hlen</strong>
        <button type="button" class="btn btn-ghost location-picker-close">\u2715</button>
      </div>
      <div id="location-picker-map" style="width:100%;height:400px;"></div>
      <div class="location-picker-footer">
        <span id="location-picker-coords">${currentLat.toFixed(6)}, ${currentLon.toFixed(6)}</span>
        <button type="button" class="btn btn-primary" id="location-picker-apply">\u00dcbernehmen</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  let selectedLat = currentLat;
  let selectedLon = currentLon;

  // Load Leaflet CSS + JS dynamically (no API key needed)
  function initLeafletMap() {
    const mapContainer = document.getElementById('location-picker-map');
    if (!mapContainer) return;
    const map = L.map(mapContainer).setView([currentLat, currentLon], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19
    }).addTo(map);
    // Fix: Leaflet needs a size recalculation after the container becomes visible
    setTimeout(() => map.invalidateSize(), 200);

    const marker = L.marker([currentLat, currentLon], { draggable: true }).addTo(map);

    function updateCoords(lat, lon) {
      selectedLat = lat;
      selectedLon = lon;
      document.getElementById('location-picker-coords').textContent =
        `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    }

    marker.on('dragend', () => {
      const pos = marker.getLatLng();
      updateCoords(pos.lat, pos.lng);
    });

    map.on('click', (e) => {
      marker.setLatLng(e.latlng);
      updateCoords(e.latlng.lat, e.latlng.lng);
    });
  }

  // Leaflet already loaded from a previous open?
  if (typeof L !== 'undefined') {
    initLeafletMap();
  } else {
    if (!document.querySelector('link[href*="leaflet"]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => initLeafletMap();
    document.head.appendChild(script);
  }

  // Close
  overlay.querySelector('.location-picker-close').addEventListener('click', () => {
    overlay.remove();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  // Apply
  document.getElementById('location-picker-apply').addEventListener('click', () => {
    if (latInput) {
      latInput.value = selectedLat.toFixed(6);
      latInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (lonInput) {
      lonInput.value = selectedLon.toFixed(6);
      lonInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    overlay.remove();
  });
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

// getActiveSettingsDestination, buildSectionMeta, renderSidebarNavigation removed — replaced by renderDestinationGrid

// Fields hidden from UI (managed automatically, user should not edit)
const HIDDEN_FIELD_PATHS = [
  'telemetry.database.host',
  'telemetry.database.port',
  'telemetry.database.name',
  'telemetry.database.user',
  'telemetry.database.password'
];

function renderDestinationGrid(destinationId) {
  const gridId = destinationId + 'Grid';
  const mount = document.getElementById(gridId);
  if (!mount) return;
  mount.innerHTML = '';

  const destination = buildDestinationWorkspace(definition, destinationId);
  if (!destination || !destination.sections.length) return;

  for (const section of destination.sections) {
    const allFields = [];
    for (const grp of section.groups || []) {
      for (const field of grp.fields || []) {
        if (field.type !== 'array' && isFieldVisible(field) && !HIDDEN_FIELD_PATHS.includes(field.path)) allFields.push(field);
      }
    }
    if (!allFields.length) continue;

    const group = createConfigGroup(section.label, getGroupAccent(section));
    // 2-column row container for compact layout
    const rowContainer = document.createElement('div');
    rowContainer.className = 'config-row-grid';
    group.appendChild(rowContainer);

    for (const field of allFields) {
      const model = buildFieldRenderModel(field);
      const input = createConfigInput(field, model.value);
      rowContainer.appendChild(createConfigRow(field.label, input));
      if (model.discovery.visible) {
        const discoveryRow = document.createElement('div');
        discoveryRow.style.cssText = 'padding:4px 14px 8px;display:flex;gap:8px;align-items:center;';
        const discBtn = document.createElement('button');
        discBtn.type = 'button';
        discBtn.className = 'btn btn-ghost btn-small';
        discBtn.dataset.discoveryRun = field.path;
        discBtn.disabled = model.discovery.loading || !model.discovery.manufacturer;
        discBtn.textContent = model.discovery.loading ? 'Suche...' : model.discovery.actionLabel;
        discoveryRow.appendChild(discBtn);
        if (model.discovery.systems.length) {
          for (const system of model.discovery.systems) {
            const pickBtn = document.createElement('button');
            pickBtn.type = 'button';
            pickBtn.className = 'btn btn-ghost btn-small';
            pickBtn.dataset.discoveryFieldPath = field.path;
            pickBtn.dataset.discoverySelectSystem = system.id;
            pickBtn.textContent = formatDiscoveredSystemOption(system);
            if (system.id === model.discovery.selectedSystemId) pickBtn.classList.add('is-active');
            discoveryRow.appendChild(pickBtn);
          }
        }
        rowContainer.appendChild(discoveryRow);
      }
    }

    mount.appendChild(group);

    if (section.id === 'pricing') {
      // EPEX price source info removed — redundant with EPEX config group
      mount.appendChild(renderPvPlantsEditor());
      mount.appendChild(renderPricingPeriodsEditor());
    }
  }

  if (shouldRenderHistoryImportPanel(destinationId)) {
    mount.appendChild(renderHistoryImportPanel(destinationId));
  }
}

function buildHistoryImportSummary(status) {
  if (!status) return 'Status wird geladen...';
  if (!status.enabled) return 'VRM-Backfill ist derzeit deaktiviert.';
  if (!status.ready) return 'VRM-Zugang ist noch nicht vollständig konfiguriert.';
  return `VRM verbunden für Portal ${status.vrmPortalId || '-'}. Historischer Nachimport ist bereit.`;
}

function renderHistoryImportPanel(destinationId) {
  const panel = document.createElement('section');
  panel.style.cssText = 'margin-top:16px;padding-top:12px;border-top:1px solid var(--flow-border);';

  const head = document.createElement('div');
  head.style.cssText = 'margin-bottom:8px;';
  head.innerHTML = `
    <p class="card-kicker">Historie</p>
    <h3 class="section-title" style="font-size:1rem;">VRM Backfill</h3>
    <p class="meta">Historische Nachimporte werden bewusst nur über VRM unterstützt. GX/Cerbo bleibt Live-Quelle.</p>
  `;
  panel.appendChild(head);

  const statusBanner = document.createElement('div');
  statusBanner.className = `status-banner ${currentHistoryImportStatus?.ready ? 'success' : 'warn'}`;
  statusBanner.textContent = buildHistoryImportSummary(currentHistoryImportStatus);
  panel.appendChild(statusBanner);

  const summary = document.createElement('div');
  summary.className = 'settings-summary';
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
    </label>
    <label class="settings-field" for="historyImportEnd">
      <span class="settings-field-title">Bis</span>
      <input id="historyImportEnd" type="datetime-local" value="${historyImportFormState.end || ''}" />
    </label>
    <label class="settings-field">
      <span class="settings-field-title">Intervall</span>
      <input type="text" value="15 Minuten" readonly />
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
    renderSettingsShell();
  });

  section.querySelectorAll('[data-remove-pv-plant]').forEach((button) => {
    button.addEventListener('click', () => {
      pvPlantsDraft = removePvPlant(pvPlantsDraft, button.dataset.removePvPlant);
      pvPlantsValidation = [];
      renderSettingsShell();
    });
  });

  section.querySelectorAll('[data-pv-plant-id][data-pv-plant-path]').forEach((input) => {
    input.addEventListener('change', () => {
      updatePvPlantField(input.dataset.pvPlantId, input.dataset.pvPlantPath, input.value);
      pvPlantsValidation = [];
      renderSettingsShell();
    });
  });

  return section;
}

function renderEpexPriceSourceInfo() {
  const section = document.createElement('section');
  section.className = 'settings-pricing-source';
  section.innerHTML = `
    <div style="margin-bottom:8px;">
      <p class="card-kicker">Preisquelle</p>
      <h3 class="section-title" style="font-size:1rem;">EPEX Day-Ahead Börsenpreise</h3>
      <p class="meta">Die Day-Ahead Börsenstrompreise werden automatisch von <strong>api.dvhub.de</strong> geladen (EPEX SPOT).</p>
    </div>
    <div id="epexBacklogInfo" class="status-banner info" style="margin-top:8px">
      Lade Preis-Backlog...
    </div>
  `;
  // Async load backlog info
  setTimeout(() => {
    const { apiFetch } = window.DVhubCommon || {};
    if (!apiFetch) return;
    Promise.all([
      apiFetch('/api/status').then(r => r.json()).catch(() => null),
      apiFetch('/api/config').then(r => r.json()).catch(() => null)
    ]).then(([status, config]) => {
      const el = document.getElementById('epexBacklogInfo');
      if (!el) return;
      const epex = status?.epex || {};
      const data = epex.data || [];
      const bzn = config?.epex?.bzn || status?.config?.epex?.bzn || 'DE-LU';
      const updatedAt = epex.updatedAt ? new Date(epex.updatedAt).toLocaleString('de-DE') : '-';
      const datapoints = data.length;
      const hoursAvailable = Math.round(datapoints * 0.25); // 15min slots → hours
      // Telemetry bounds for overall price history
      const bounds = status?.telemetry || {};
      const earliest = bounds.earliest ? new Date(bounds.earliest).toLocaleDateString('de-DE') : null;
      const latest = bounds.latest ? new Date(bounds.latest).toLocaleDateString('de-DE') : null;
      const backlogRange = earliest && latest ? `${earliest} bis ${latest}` : `${hoursAvailable}h heute`;
      el.innerHTML = `
        <strong>Bidding Zone:</strong> ${bzn} &nbsp;|&nbsp;
        <strong>Letztes Update:</strong> ${updatedAt} &nbsp;|&nbsp;
        <strong>Heute:</strong> ${datapoints} Slots (${hoursAvailable}h)
        ${earliest ? `<br><strong>Telemetrie-Historie:</strong> ${backlogRange}` : ''}
        <br><small style="opacity:0.7">Quelle: api.dvhub.de → EPEX SPOT Day-Ahead Auktion</small>
      `;
    }).catch(() => {
      const el = document.getElementById('epexBacklogInfo');
      if (el) el.textContent = 'Preis-Backlog konnte nicht geladen werden.';
    });
  }, 500);
  return section;
}

function renderPricingPeriodsEditor() {
  const section = document.createElement('section');
  section.className = 'settings-pricing-periods';
  const validation = pricingPeriodsValidation.length
    ? `<div class="status-banner error">${pricingPeriodsValidation.map((message) => `<div>${message}</div>`).join('')}</div>`
    : '<div class="status-banner info">Tarifzeiträume werden tagesgenau auf die Historienberechnung angewendet.</div>';

  section.innerHTML = `
    <div style="margin-bottom:8px;">
      <p class="card-kicker">Bezugspreise nach Zeitraum</p>
      <h3 class="section-title" style="font-size:1rem;">Tarifzeiträume</h3>
      <p class="meta">${pricingPeriodsDraft.length} definierte Zeiträume · Fixe oder dynamische Tarife pro Zeitraum.</p>
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
    renderSettingsShell();
  });

  section.querySelectorAll('[data-remove-period]').forEach((button) => {
    button.addEventListener('click', () => {
      pricingPeriodsDraft = removePricingPeriod(pricingPeriodsDraft, button.dataset.removePeriod);
      pricingPeriodsValidation = [];
      renderSettingsShell();
    });
  });

  section.querySelectorAll('[data-period-id][data-period-path]').forEach((input) => {
    input.addEventListener('change', () => {
      updatePricingPeriodField(input.dataset.periodId, input.dataset.periodPath, input.value);
      pricingPeriodsValidation = [];
      renderSettingsShell();
    });
  });

  return section;
}

function bindHistoryImportControls(panel) {
  const handleChange = () => {
    syncHistoryImportForm(panel);
    renderSettingsShell();
  };

  panel.querySelector('#historyImportStart')?.addEventListener('change', handleChange);
  panel.querySelector('#historyImportEnd')?.addEventListener('change', handleChange);
  panel.querySelector('#historyImportBtn')?.addEventListener('click', () => {
    triggerHistoryImport().catch((error) => {
      currentHistoryImportResult = { ok: false, error: error.message };
      historyImportBusy = false;
      renderSettingsShell();
    });
  });
  panel.querySelector('#historyBackfillBtn')?.addEventListener('click', () => {
    triggerHistoryBackfill().catch((error) => {
      currentHistoryImportResult = { ok: false, error: error.message };
      historyImportBusy = false;
      renderSettingsShell();
    });
  });
}

// renderActiveSettingsDestination removed — each grid is rendered independently via renderDestinationGrid

function renderSettingsShell() {
  settingsShellState = createSettingsShellState(definition, settingsShellState.activeSectionId);
  const DEST_TO_GRID = { connection: 'connection', control: 'control', services: 'services' };
  for (const dest of settingsShellState.destinations) {
    if (!DEST_TO_GRID[dest.id]) continue;
    renderDestinationGrid(dest.id);
  }
  updateSaveBar();
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
}

function updateSaveBar() {
  if (!definition) return;
  const changed = JSON.stringify(currentDraftConfig) !== JSON.stringify(currentRawConfig);
  document.body.classList.toggle('has-changes', changed);
  const text = document.getElementById('saveBarText');
  if (text) {
    const count = countChangedFields();
    text.textContent = changed ? `${count} Feld${count === 1 ? '' : 'er'} geaendert` : '';
  }
}

function countChangedFields() {
  let count = 0;
  for (const field of definition?.fields || []) {
    const input = document.getElementById(fieldId(field.path));
    if (!input) continue;
    const draft = parseFieldInput(field);
    const saved = getPath(currentRawConfig, field.path);
    if (JSON.stringify(draft) !== JSON.stringify(saved)) count++;
  }
  return count;
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
  renderSettingsShell();
  return true;
}

async function triggerHistoryImport() {
  historyImportBusy = true;
  renderSettingsShell();
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
  renderSettingsShell();
  if (!res.ok || !body.ok) throw new Error(body.error || String(res.status));
}

async function triggerHistoryBackfill() {
  historyImportBusy = true;
  renderSettingsShell();
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
  renderSettingsShell();
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
    renderSettingsShell();
    return;
  }

  setFieldDiscoveryState(fieldPath, createDiscoveryState({
    manufacturer,
    loading: true
  }));
  renderSettingsShell();

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

  renderSettingsShell();
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
  renderSettingsShell();
}

async function saveCurrentForm() {
  const config = collectConfigFromForm();
  const pricingValidation = validatePricingPeriods(pricingPeriodsDraft);
  const pvValidation = validatePvPlants(pvPlantsDraft);
  pricingPeriodsValidation = pricingValidation.messages;
  pvPlantsValidation = pvValidation.messages;
  if (!pricingValidation.valid || !pvValidation.valid) {
    renderSettingsShell();
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
  // Delegated change listeners on the three grid containers
  for (const gridId of ['connectionGrid', 'controlGrid', 'servicesGrid']) {
    document.getElementById(gridId)?.addEventListener('change', (event) => {
      const input = event.target;
      if (!input?.dataset?.path) return;
      syncRenderedFieldsToDraft();
      updateSaveBar();
      if (input.dataset.path === 'manufacturer') settingsDiscoveryStates = {};
      if (fieldAffectsVisibility(input.dataset.path)) renderSettingsShell();
    });

    document.getElementById(gridId)?.addEventListener('click', (event) => {
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
  }

  // Discard button resets draft to saved config and re-renders
  document.getElementById('discardBtn')?.addEventListener('click', () => {
    currentDraftConfig = clone(currentRawConfig);
    pricingPeriodsDraft = clone(currentRawConfig?.userEnergyPricing?.periods || []);
    marketValueModeDraft = getDraftMarketValueMode(currentRawConfig);
    pvPlantsDraft = (currentRawConfig?.userEnergyPricing?.pvPlants || []).map((plant, index) => ({
      ...createEmptyPvPlant(index),
      kwp: plant?.kwp ?? '',
      commissionedAt: plant?.commissionedAt || ''
    }));
    pricingPeriodsValidation = [];
    pvPlantsValidation = [];
    renderSettingsShell();
    updateSaveBar();
    setBanner('Aenderungen verworfen.', 'info');
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
    setBanner('API-Zugriff abgelehnt. Falls ein API-Token gesetzt ist, die Seite mit ?token=DEIN_TOKEN oeffnen oder das Token neu speichern.', 'error');
  });

  // Connection status banner
  apiFetch('/api/status').then(res => res.json()).then(status => {
    const banner = document.getElementById('connectionBanner');
    if (!banner) return;
    const ok = status?.victron?.connected;
    banner.className = `status-banner ${ok ? 'success' : 'warn'}`;
    banner.textContent = ok
      ? `Verbunden mit ${status.victron?.host || 'Victron'}`
      : 'Keine Verbindung zum Victron-System.';
  }).catch(() => {
    const banner = document.getElementById('connectionBanner');
    if (banner) {
      banner.className = 'status-banner error';
      banner.textContent = 'Status konnte nicht geladen werden.';
    }
  });

  // Tab switching (must be in external JS — CSP blocks inline scripts)
  const tabContainer = document.querySelector('.settings-tabs');
  if (tabContainer) {
    tabContainer.addEventListener('click', (e) => {
      const tab = e.target.closest('.settings-tab');
      if (!tab) return;
      const target = tab.dataset.tab;
      document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      document.querySelectorAll('.settings-tab-panel').forEach(p => { p.hidden = true; });
      const panel = document.getElementById('tab-' + target);
      if (panel) panel.hidden = false;
      history.replaceState(null, '', '#' + target);
      syncRenderedFieldsToDraft();
    });
    // Restore tab from URL hash
    const hash = location.hash.replace('#', '');
    if (hash) {
      const tab = document.querySelector('.settings-tab[data-tab="' + hash + '"]');
      if (tab) tab.click();
    }
  }

  loadConfig().catch((error) => {
    setBanner(`Konfiguration konnte nicht geladen werden: ${error.message}`, 'error');
  });
  loadHistoryImportStatus().then(() => {
    renderSettingsShell();
  }).catch((error) => {
    currentHistoryImportResult = { ok: false, error: error.message };
    renderSettingsShell();
  });
}

if (typeof document !== 'undefined') {
  initSettingsPage();
}

window.DVhubSettings = {
  activate: activateSettingsDestination,
  onTabSwitch: function(tabId) { syncRenderedFieldsToDraft(); }
};
