const common = typeof window !== 'undefined' ? window.DVhubCommon || {} : {};
const { apiFetch, buildApiUrl, escapeHtml, setStoredApiToken } = common;

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
let forecastStringsDraft = [];
let forecastTierCache = null;

const GROUP_ACCENTS = {
  connection: 'green', transport: 'green', victron: 'green',
  modbus: 'yellow', dvProxy: 'yellow', dv: 'yellow', control: 'yellow',
  schedule: 'green', automation: 'yellow', dvControl: 'blue',
  location: 'blue', standort: 'blue',
  telemetry: 'cyan', vrm: 'cyan',
  webserver: 'purple', http: 'purple', api: 'purple',
  mqtt: 'orange',
  epex: 'green', pricing: 'yellow', pvPlants: 'blue',
  forecast: 'cyan', forecastGeneral: 'cyan', forecastLocation: 'blue',
  forecastPv: 'green', forecastSolcast: 'yellow', forecastWeather: 'blue',
  forecastLoad: 'orange', forecastRetention: 'purple'
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
  if (opts?.help) {
    const tip = document.createElement('span');
    tip.className = 'config-help-icon';
    tip.textContent = '\u24D8';
    tip.dataset.tooltip = opts.help;
    labelSpan.appendChild(tip);
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

function createConfigInput(field, value, inherited) {
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
      apiFetch(field.dynamicOptionsUrl).then(r => r.json()).then(data => {
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
    if ((input.value === '') && inherited !== null && inherited !== undefined && inherited !== '') {
      if (field.empty === 'delete') {
        input.placeholder = `Vererbt: ${inherited}`;
      } else {
        input.placeholder = String(inherited);
      }
    }
    const valStr = String(input.value || input.placeholder || '');
    const charW = field.type === 'number' ? 10 : 8;
    input.style.width = `${Math.max(field.type === 'number' ? 80 : 120, valStr.length * charW + 30)}px`;
  }
  input.id = fieldId(field.path);
  input.dataset.path = field.path;
  input.dataset.type = field.type;
  if (field.readOnly) {
    input.readOnly = true;
    input.disabled = true;
    input.style.opacity = '0.6';
    input.title = field.help || 'Dieses Feld wird automatisch uebernommen';
  }
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
  return destinationId === 'services';
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
    <div class="config-group-kicker" style="color:var(--flow-purple);padding-top:10px;">Marktprämie</div>
    ${validationHtml}
    <div class="config-row-grid">
      <div class="config-row">
        <span class="config-row-label">Marktwert-Modus</span>
        <select id="marketValueModeSelect" class="config-select">
          <option value="annual"${selectedMode === 'annual' ? ' selected' : ''}>Jahresmarktwert</option>
          <option value="monthly"${selectedMode === 'monthly' ? ' selected' : ''}>Monatsmarktwert</option>
        </select>
      </div>
      <div class="config-row">
        <span class="config-row-label">Anlagen</span>
        <strong class="config-row-value">${plants.length} konfiguriert</strong>
      </div>
    </div>
    <div style="padding:8px 14px;">
      <button id="addPvPlantBtn" class="btn btn-ghost btn-small" type="button">+ PV-Anlage</button>
    </div>
    ${plants.map((plant) => `
      <div class="config-row-grid" data-pv-plant-id="${escapeHtml(plant.id)}" style="border-top:1px solid rgba(255,255,255,0.06);">
        <div class="config-row">
          <span class="config-row-label">Leistung (kWp)</span>
          <input class="config-input" data-pv-plant-id="${escapeHtml(plant.id)}" data-pv-plant-path="kwp" type="number" step="0.01" min="0" value="${escapeHtml(plant.kwp ?? '')}" style="width:80px;" />
        </div>
        <div class="config-row">
          <span class="config-row-label">Inbetriebnahme</span>
          <input class="config-input" data-pv-plant-id="${escapeHtml(plant.id)}" data-pv-plant-path="commissionedAt" type="date" value="${escapeHtml(plant.commissionedAt || '')}" style="width:140px;" />
        </div>
      </div>
      <div style="padding:2px 14px 8px;"><button class="btn btn-danger btn-small" type="button" data-remove-pv-plant="${escapeHtml(plant.id)}">Entfernen</button></div>
    `).join('')}
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
  el.className = `config-banner ${kind}`;
}

function showSettingsRestartButton() {
  const el = document.getElementById('settingsBanner');
  if (!el) return;
  if (el.querySelector('#settingsRestartBtn')) return;
  const btn = document.createElement('button');
  btn.id = 'settingsRestartBtn';
  btn.className = 'btn btn-danger btn-small';
  btn.style.cssText = 'margin-left:12px;vertical-align:middle;';
  btn.textContent = 'Jetzt neu starten';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Wird neu gestartet...';
    try {
      await restartService();
    } catch (e) {
      setBanner('Restart fehlgeschlagen: ' + e.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Jetzt neu starten';
    }
  });
  el.appendChild(btn);
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

  // inheritFrom: auto-populate from another config path if current value is empty/zero
  if (field.inheritFrom && (!draftDefined || draftValue === 0 || draftValue === null || draftValue === undefined || draftValue === '')) {
    const inheritedVal = getPath(effectiveConfig, field.inheritFrom) || getPath(draftConfig, field.inheritFrom);
    if (inheritedVal !== undefined && inheritedVal !== null && inheritedVal !== 0) {
      return { value: inheritedVal, inherited: null };
    }
  }

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
  if (field.hidden) return false;

  if (field.visibleWhenPath) {
    const currentValue = getVisibilityValue(field.visibleWhenPath.path);
    // Support 'equals' (show when value matches) and 'notEquals' (show when value differs)
    if ('equals' in field.visibleWhenPath) {
      if (!valuesEqual(currentValue, field.visibleWhenPath.equals)) return false;
    }
    if ('notEquals' in field.visibleWhenPath) {
      if (valuesEqual(currentValue, field.visibleWhenPath.notEquals)) return false;
    }
    // Support 'oneOf' (show when value is in the array)
    if (Array.isArray(field.visibleWhenPath.oneOf)) {
      if (!field.visibleWhenPath.oneOf.some(v => valuesEqual(currentValue, v))) return false;
    }
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
  card.className = 'config-row';
  const label = document.createElement('span');
  label.className = 'config-row-label';
  label.textContent = title;
  card.appendChild(label);
  const val = document.createElement('strong');
  val.className = 'config-row-value';
  val.textContent = text;
  card.appendChild(val);
  return card;
}

// --- Forecast section helpers ---

/**
 * Render RAM tier info card for the forecast section header.
 * Reads tier info from cached /api/status or state.forecast.
 */
function renderForecastTierInfo() {
  const tierDiv = document.createElement('div');
  tierDiv.className = 'config-row-grid';
  tierDiv.style.cssText = 'margin:4px 0 8px;';

  const tierLabel = forecastTierCache
    ? `Tier ${forecastTierCache.tier} (${forecastTierCache.totalMB} MB RAM)`
    : 'Wird ermittelt...';

  const row = document.createElement('div');
  row.className = 'config-row';
  const label = document.createElement('span');
  label.className = 'config-row-label';
  label.textContent = 'Erkannte RAM-Stufe';
  row.appendChild(label);
  const val = document.createElement('strong');
  val.className = 'config-row-value';
  val.id = 'forecastTierValue';
  val.textContent = tierLabel;
  row.appendChild(val);
  tierDiv.appendChild(row);

  // Fetch tier info if not cached
  if (!forecastTierCache && typeof apiFetch === 'function') {
    apiFetch(buildApiUrl('/api/status')).then(r => r.json()).then(data => {
      if (data?.forecast?.tier) {
        forecastTierCache = { tier: data.forecast.tier, totalMB: data.forecast.totalMB || '?' };
        const el = document.getElementById('forecastTierValue');
        if (el) el.textContent = `Tier ${forecastTierCache.tier} (${forecastTierCache.totalMB} MB RAM)`;
      }
    }).catch(() => { /* silent */ });
  }

  return tierDiv;
}

/**
 * Render multi-string editor for PV detailed configuration mode (D-11).
 * Dynamic list of { label, kwp, tiltDeg, azimuthDeg } entries.
 */
function renderForecastStringEditor() {
  // Initialize draft from config if empty
  if (!forecastStringsDraft.length) {
    const cfgStrings = getVisibilityValue('forecast.pv.strings');
    if (Array.isArray(cfgStrings) && cfgStrings.length > 0) {
      forecastStringsDraft = cfgStrings.map(s => ({ ...s }));
    } else {
      forecastStringsDraft = [{ label: 'String 1', kwp: 5, tiltDeg: 35, azimuthDeg: 180 }];
    }
  }

  const section = document.createElement('div');
  section.className = 'config-group';
  section.dataset.accent = 'green';

  const kicker = document.createElement('div');
  kicker.className = 'config-group-kicker';
  kicker.style.color = 'var(--flow-green)';
  kicker.textContent = 'PV-Strings (Detailliert)';
  section.appendChild(kicker);

  const desc = document.createElement('p');
  desc.style.cssText = 'padding:4px 14px;font-size:12px;color:rgba(232,234,240,0.4);margin:0;';
  desc.textContent = 'Jede Dachflaeche mit eigener Ausrichtung als separaten String anlegen. Beispiel: Sued-Dach 15 kWp + Ost-Garage 5 kWp.';
  section.appendChild(desc);

  // Column headers
  const headerRow = document.createElement('div');
  headerRow.style.cssText = 'display:grid;grid-template-columns:1fr 80px 80px 80px auto;gap:8px;padding:4px 14px;font-size:11px;color:rgba(232,234,240,0.4);';
  headerRow.innerHTML = '<span>Bezeichnung</span><span style="text-align:right">kWp</span><span style="text-align:right">Neigung°</span><span style="text-align:right">Richtung°</span><span></span>';
  section.appendChild(headerRow);

  const list = document.createElement('div');
  list.id = 'forecastStringsList';
  list.style.cssText = 'padding:4px 14px;';

  for (let i = 0; i < forecastStringsDraft.length; i++) {
    list.appendChild(renderStringRow(i));
  }
  section.appendChild(list);

  const addRow = document.createElement('div');
  addRow.style.cssText = 'padding:8px 14px;';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-ghost btn-small';
  addBtn.textContent = '+ String hinzufuegen';
  addBtn.addEventListener('click', () => {
    forecastStringsDraft.push({
      label: `String ${forecastStringsDraft.length + 1}`,
      kwp: 5,
      tiltDeg: 35,
      azimuthDeg: 180
    });
    syncForecastStringsToDraft();
    renderSettingsShell();
    updateSaveBar();
  });
  addRow.appendChild(addBtn);
  section.appendChild(addRow);

  return section;
}

function renderStringRow(index) {
  const s = forecastStringsDraft[index];
  const row = document.createElement('div');
  row.style.cssText = 'display:grid;grid-template-columns:1fr 80px 80px 80px auto;gap:8px;align-items:center;margin-bottom:6px;';

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'config-input';
  labelInput.placeholder = 'z.B. Sued-Dach, Ost-Garage';
  labelInput.title = 'Name dieser Dachflaeche (frei waehlbar)';
  labelInput.value = s.label || '';
  labelInput.addEventListener('input', () => {
    forecastStringsDraft[index].label = labelInput.value;
    syncForecastStringsToDraft();
    updateSaveBar();
  });
  row.appendChild(labelInput);

  const kwpInput = document.createElement('input');
  kwpInput.type = 'number';
  kwpInput.className = 'config-input';
  kwpInput.placeholder = 'kWp';
  kwpInput.min = '0.1';
  kwpInput.step = '0.1';
  kwpInput.value = s.kwp ?? '';
  kwpInput.style.textAlign = 'right';
  kwpInput.title = 'Installierte Leistung dieser Dachflaeche in kWp';
  kwpInput.addEventListener('input', () => {
    forecastStringsDraft[index].kwp = parseFloat(kwpInput.value) || 0;
    syncForecastStringsToDraft();
    updateSaveBar();
  });
  row.appendChild(kwpInput);

  const tiltInput = document.createElement('input');
  tiltInput.type = 'number';
  tiltInput.className = 'config-input';
  tiltInput.placeholder = 'Neigung°';
  tiltInput.min = '0';
  tiltInput.max = '90';
  tiltInput.value = s.tiltDeg ?? '';
  tiltInput.style.textAlign = 'right';
  tiltInput.title = 'Dachneigung in Grad (0=flach, 35=typisch, 90=senkrecht)';
  tiltInput.addEventListener('input', () => {
    forecastStringsDraft[index].tiltDeg = parseInt(tiltInput.value, 10) || 0;
    syncForecastStringsToDraft();
    updateSaveBar();
  });
  row.appendChild(tiltInput);

  const azInput = document.createElement('input');
  azInput.type = 'number';
  azInput.className = 'config-input';
  azInput.placeholder = 'Richtung°';
  azInput.min = '0';
  azInput.max = '360';
  azInput.value = s.azimuthDeg ?? '';
  azInput.style.textAlign = 'right';
  azInput.title = 'Himmelsrichtung (0=Nord, 90=Ost, 180=Sued, 270=West)';
  azInput.addEventListener('input', () => {
    forecastStringsDraft[index].azimuthDeg = parseInt(azInput.value, 10) || 0;
    syncForecastStringsToDraft();
    updateSaveBar();
  });
  row.appendChild(azInput);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn btn-ghost btn-small';
  removeBtn.style.color = 'var(--err)';
  removeBtn.textContent = 'X';
  removeBtn.addEventListener('click', () => {
    forecastStringsDraft.splice(index, 1);
    if (!forecastStringsDraft.length) {
      forecastStringsDraft.push({ label: 'String 1', kwp: 5, tiltDeg: 35, azimuthDeg: 180 });
    }
    syncForecastStringsToDraft();
    renderSettingsShell();
    updateSaveBar();
  });
  row.appendChild(removeBtn);

  return row;
}

function syncForecastStringsToDraft() {
  if (!currentDraftConfig.forecast) currentDraftConfig.forecast = {};
  if (!currentDraftConfig.forecast.pv) currentDraftConfig.forecast.pv = {};
  currentDraftConfig.forecast.pv.strings = forecastStringsDraft.map(s => ({ ...s }));
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
      const input = createConfigInput(field, model.value, model.inherited);
      rowContainer.appendChild(createConfigRow(field.label, input, { help: field.help }));
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

    // Add map picker button if location fields are present in this group
    const locationField = allFields.find(f => f.path && f.path.endsWith('.location.latitude'));
    if (locationField) {
      const basePath = locationField.path.replace('.latitude', '');
      const mapRow = document.createElement('div');
      mapRow.style.cssText = 'padding:4px 14px 12px;';
      const mapBtn = document.createElement('button');
      mapBtn.type = 'button';
      mapBtn.className = 'btn btn-ghost btn-small';
      mapBtn.textContent = '\u{1F5FA}\uFE0F Auf Karte w\u00e4hlen';
      mapBtn.addEventListener('click', () => openLocationPicker(basePath));
      mapRow.appendChild(mapBtn);
      rowContainer.appendChild(mapRow);
    }

    // Forecast section: prepend RAM tier info card
    if (section.id === 'forecast') {
      const tierInfo = renderForecastTierInfo();
      if (tierInfo) group.insertBefore(tierInfo, group.firstChild.nextSibling);
    }

    mount.appendChild(group);

    if (section.id === 'pricing') {
      // EPEX price source info removed — redundant with EPEX config group
      mount.appendChild(renderPvPlantsEditor());
      mount.appendChild(renderPricingPeriodsEditor());
    }

    // Forecast section: append multi-string editor when in detailed mode
    if (section.id === 'forecast') {
      const configLevel = getVisibilityValue('forecast.pv.configLevel') || 'simple';
      if (configLevel === 'detailed') {
        mount.appendChild(renderForecastStringEditor());
      }
    }
  }

  if (shouldRenderHistoryImportPanel(destinationId)) {
    mount.appendChild(renderHistoryImportPanel(destinationId));
  }

  if (destinationId === 'connection') {
    mount.appendChild(renderVpnUploadPanel());
  }

  // If only one card in the grid, span full width
  if (mount.children.length === 1) {
    mount.children[0].style.gridColumn = '1 / -1';
  }
}

function buildHistoryImportSummary(status) {
  if (!status) return 'Status wird geladen...';
  if (!status.enabled) return 'VRM-Backfill ist derzeit deaktiviert.';
  if (!status.ready) return 'VRM-Zugang ist noch nicht vollständig konfiguriert.';
  return `VRM verbunden für Portal ${escapeHtml(status.vrmPortalId || '-')}. Historischer Nachimport ist bereit.`;
}

function renderHistoryImportPanel(destinationId) {
  const panel = document.createElement('section');
  panel.className = 'config-group config-group--full';
  panel.style.gridColumn = '1 / -1';
  panel.dataset.accent = 'yellow';

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

  panel.innerHTML = `
    <div class="config-group-kicker" style="color:var(--flow-yellow);">VRM Backfill</div>
    <div class="config-banner ${currentHistoryImportStatus?.ready ? 'ok' : 'warn'}" style="margin:4px 14px;">
      ${buildHistoryImportSummary(currentHistoryImportStatus)}
    </div>
    <div class="config-row-grid">
      <div class="config-row">
        <span class="config-row-label">Quelle</span>
        <strong class="config-row-value">VRM Portal</strong>
      </div>
      <div class="config-row">
        <span class="config-row-label">Portal ID</span>
        <strong class="config-row-value">${escapeHtml(currentHistoryImportStatus?.vrmPortalId || '-')}</strong>
      </div>
    </div>
    <div class="config-row-grid">
      <div class="config-row">
        <span class="config-row-label">Von</span>
        <input id="historyImportStart" type="datetime-local" class="config-input" style="width:180px;" value="${historyImportFormState.start || ''}" />
      </div>
      <div class="config-row">
        <span class="config-row-label">Bis</span>
        <input id="historyImportEnd" type="datetime-local" class="config-input" style="width:180px;" value="${historyImportFormState.end || ''}" />
      </div>
    </div>
    <div class="config-row">
      <span class="config-row-label">Intervall</span>
      <strong class="config-row-value">15 Minuten</strong>
    </div>
    <div style="padding:8px 14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
      <button id="historyImportBtn" type="button" class="btn btn-primary btn-small" ${actionState.disabled ? 'disabled' : ''}>
        ${historyImportBusy ? 'VRM-Job läuft...' : 'VRM-Historie importieren'}
      </button>
      <button id="historyBackfillBtn" type="button" class="btn btn-ghost btn-small" ${backfillState.disabled ? 'disabled' : ''}>
        ${historyImportBusy ? 'VRM-Job läuft...' : 'VRM-Backfill starten'}
      </button>
    </div>
    <p style="padding:2px 14px 4px;font-size:11px;color:rgba(232,234,240,0.35);margin:0;">
      ${actionState.reason || backfillState.reason || 'Importiert einen expliziten Zeitraum oder startet einen automatischen VRM-Backfill.'}
    </p>
    <div id="historyImportResult" class="config-banner ${currentHistoryImportResult?.ok ? 'ok' : currentHistoryImportResult?.error ? 'error' : 'info'}" style="margin:4px 14px 8px;">
      ${formatHistoryImportResult(currentHistoryImportResult)}
    </div>
  `;

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
  section.className = 'config-group config-group--full';
  section.style.gridColumn = '1 / -1';
  section.dataset.accent = 'purple';
  const validation = pvPlantsValidation.length
    ? `<div class="config-banner error">${pvPlantsValidation.map((message) => `<div>${escapeHtml(message)}</div>`).join('')}</div>`
    : '<div class="config-banner info">Mehrere PV-Anlagen werden über Leistung und Inbetriebnahme für die jährliche Marktprämie gewichtet.</div>';
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
  section.className = 'config-group';
  section.dataset.accent = 'green';
  section.innerHTML = `
    <div class="config-group-kicker" style="color:var(--flow-green);">Preisquelle</div>
    <p style="padding:4px 14px;font-size:12px;color:rgba(232,234,240,0.4);margin:0;">Day-Ahead Börsenstrompreise von <strong>api.dvhub.de</strong> (EPEX SPOT).</p>
    <div id="epexBacklogInfo" class="config-banner info" style="margin:6px 14px;">
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
        <strong>Bidding Zone:</strong> ${escapeHtml(bzn)} &nbsp;|&nbsp;
        <strong>Letztes Update:</strong> ${escapeHtml(updatedAt)} &nbsp;|&nbsp;
        <strong>Heute:</strong> ${escapeHtml(datapoints)} Slots (${escapeHtml(hoursAvailable)}h)
        ${earliest ? `<br><strong>Telemetrie-Historie:</strong> ${escapeHtml(backlogRange)}` : ''}
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
  section.className = 'config-group config-group--full';
  section.style.gridColumn = '1 / -1';
  section.dataset.accent = 'yellow';
  const validation = pricingPeriodsValidation.length
    ? `<div class="config-banner error">${pricingPeriodsValidation.map((message) => `<div>${escapeHtml(message)}</div>`).join('')}</div>`
    : '';

  section.innerHTML = `
    <div class="config-group-kicker" style="color:var(--flow-yellow);">Bezugspreise nach Zeitraum</div>
    <div class="config-row">
      <span class="config-row-label">Tarifzeiträume</span>
      <strong class="config-row-value">${pricingPeriodsDraft.length} definiert</strong>
    </div>
    ${validation}
    <div style="padding:8px 14px;">
      <button id="addPricingPeriodBtn" class="btn btn-ghost btn-small" type="button">+ Zeitraum</button>
    </div>
    ${pricingPeriodsDraft.map((period) => `
      <div style="border-top:1px solid rgba(255,255,255,0.06);padding:4px 0;">
        <div class="config-row-grid">
          <div class="config-row">
            <span class="config-row-label">Bezeichnung</span>
            <input class="config-input" data-period-id="${escapeHtml(period.id)}" data-period-path="label" type="text" value="${escapeHtml(period.label || '')}" style="width:120px;" />
          </div>
          <div class="config-row">
            <span class="config-row-label">Modus</span>
            <select class="config-select" data-period-id="${escapeHtml(period.id)}" data-period-path="mode">
              <option value="fixed"${period.mode === 'fixed' ? ' selected' : ''}>Fixpreis</option>
              <option value="dynamic"${period.mode === 'dynamic' ? ' selected' : ''}>Dynamisch</option>
            </select>
          </div>
        </div>
        <div class="config-row-grid">
          <div class="config-row">
            <span class="config-row-label">Start</span>
            <input class="config-input" data-period-id="${escapeHtml(period.id)}" data-period-path="startDate" type="date" value="${escapeHtml(period.startDate || '')}" style="width:140px;" />
          </div>
          <div class="config-row">
            <span class="config-row-label">Ende</span>
            <input class="config-input" data-period-id="${escapeHtml(period.id)}" data-period-path="endDate" type="date" value="${escapeHtml(period.endDate || '')}" style="width:140px;" />
          </div>
        </div>
        ${period.mode === 'fixed' ? `
          <div class="config-row-grid">
            <div class="config-row">
              <span class="config-row-label">Bruttopreis (ct/kWh)</span>
              <input class="config-input" data-period-id="${escapeHtml(period.id)}" data-period-path="fixedGrossImportCtKwh" type="number" step="0.01" value="${escapeHtml(period.fixedGrossImportCtKwh ?? '')}" style="width:80px;" />
            </div>
          </div>
        ` : `
          <div class="config-row-grid">
            <div class="config-row">
              <span class="config-row-label">Energie-Aufschlag</span>
              <input class="config-input" data-period-id="${escapeHtml(period.id)}" data-period-path="dynamicComponents.energyMarkupCtKwh" type="number" step="0.01" value="${escapeHtml(period.dynamicComponents?.energyMarkupCtKwh ?? '')}" style="width:80px;" />
            </div>
            <div class="config-row">
              <span class="config-row-label">Netzentgelte</span>
              <input class="config-input" data-period-id="${escapeHtml(period.id)}" data-period-path="dynamicComponents.gridChargesCtKwh" type="number" step="0.01" value="${escapeHtml(period.dynamicComponents?.gridChargesCtKwh ?? '')}" style="width:80px;" />
            </div>
          </div>
          <div class="config-row-grid">
            <div class="config-row">
              <span class="config-row-label">Umlagen &amp; Abgaben</span>
              <input class="config-input" data-period-id="${escapeHtml(period.id)}" data-period-path="dynamicComponents.leviesAndFeesCtKwh" type="number" step="0.01" value="${escapeHtml(period.dynamicComponents?.leviesAndFeesCtKwh ?? '')}" style="width:80px;" />
            </div>
            <div class="config-row">
              <span class="config-row-label">MwSt (%)</span>
              <input class="config-input" data-period-id="${escapeHtml(period.id)}" data-period-path="dynamicComponents.vatPct" type="number" step="0.01" value="${escapeHtml(period.dynamicComponents?.vatPct ?? '')}" style="width:80px;" />
            </div>
          </div>
        `}
        <div style="padding:2px 14px 8px;"><button class="btn btn-danger btn-small" type="button" data-remove-period="${escapeHtml(period.id)}">Entfernen</button></div>
      </div>
    `).join('')}
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
    if (parsed === undefined) continue; // json-type fields return undefined — skip
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
    text.textContent = changed ? `${count} Feld${count === 1 ? '' : 'er'} geändert` : '';
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
  // JSON fields (e.g. forecast.pv.strings) are managed by custom handlers, not form inputs
  if (field.type === 'json') return undefined;

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
  syncForecastStringsToDraft(); // MUST run after syncRenderedFieldsToDraft to override string-coerced value
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
  forecastStringsDraft = clone(currentRawConfig?.forecast?.pv?.strings || []);
  forecastTierCache = null;
  settingsShellState = createSettingsShellState(definition);
  setStoredApiToken(currentEffectiveConfig.apiToken || '');
  document.getElementById('configMeta').textContent = buildMetaText(currentMeta);
  renderSettingsShell();
}

function setHealthBanner(message, kind = 'info') {
  const el = document.getElementById('healthBanner');
  if (!el) return;
  el.textContent = message;
  el.className = `config-banner ${kind}`;
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
      `Service: ${service.name || '-'} | Status: ${service.status || '-'} | Runtime: ${payload.runtime?.node || '-'} | Geprüft: ${fmtTs(payload.checkedAt)}`;
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

  if (payload.restartRequired) {
    setBanner(`Konfiguration gespeichert. Neustart empfohlen für: ${payload.restartRequiredPaths.join(', ')}`, 'warn');
    showSettingsRestartButton();
  } else {
    setBanner('Konfiguration gespeichert.', 'success');
  }
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

// ── System Updates (OS packages) ──

async function loadSystemInfo() {
  const banner = document.getElementById('systemInfoBanner');
  if (!banner) return;
  try {
    const r = await apiFetch('/api/admin/system/info');
    const info = await r.json();
    if (!info.ok) { banner.textContent = 'Systeminfo nicht verfügbar'; return; }
    let html = `<strong>${escapeHtml(info.hostname)}</strong>`;
    html += ` | Kernel: ${escapeHtml(info.kernel)}`;
    html += ` | Node: ${escapeHtml(info.nodeVersion)}`;
    html += ` | Uptime: ${escapeHtml(info.uptime)}`;
    if (info.memory) html += ` | RAM: ${info.memory.usedMb}/${info.memory.totalMb} MB`;
    if (info.disk) html += ` | Disk: ${escapeHtml(info.disk.used)}/${escapeHtml(info.disk.size)} (${escapeHtml(info.disk.usePct)})`;
    banner.innerHTML = html;
  } catch {
    banner.textContent = 'Systeminfo konnte nicht geladen werden.';
  }
}

async function checkSystemUpdates() {
  const banner = document.getElementById('systemUpdatesBanner');
  const list = document.getElementById('systemUpdatesList');
  const actions = document.getElementById('systemUpdatesActions');
  const meta = document.getElementById('systemUpdatesMeta');
  if (!banner) return;
  banner.style.display = '';
  banner.textContent = 'Prüfe auf System-Updates...';
  if (list) list.style.display = 'none';
  if (actions) actions.style.display = 'none';
  try {
    const r = await apiFetch('/api/admin/system/updates/check');
    const data = await r.json();
    if (!data.ok) { banner.textContent = 'Fehler: ' + (data.error || 'unbekannt'); return; }
    if (data.totalCount === 0) {
      banner.innerHTML = '<span style="color:var(--ok);">System ist aktuell — keine Updates verfügbar.</span>';
      if (meta) meta.textContent = `Geprüft: ${new Date(data.checkedAt).toLocaleString('de-DE')}`;
      return;
    }
    const secNote = data.securityCount > 0 ? ` (davon ${data.securityCount} Sicherheits-Updates)` : '';
    banner.innerHTML = `<strong style="color:var(--c-amber-600);">${data.totalCount} Updates verfügbar${secNote}</strong>`;
    if (list && data.packages.length > 0) {
      list.style.display = '';
      let html = '<table style="width:100%;border-collapse:collapse;font-size:0.7rem;">';
      html += '<tr style="opacity:0.6;"><td style="padding:2px 6px;">Paket</td><td>Aktuell</td><td>Neu</td></tr>';
      for (const p of data.packages) {
        html += `<tr><td style="padding:2px 6px;font-family:monospace;">${escapeHtml(p.name)}</td><td style="opacity:0.6;">${escapeHtml(p.currentVersion)}</td><td>${escapeHtml(p.newVersion)}</td></tr>`;
      }
      html += '</table>';
      list.innerHTML = html;
    }
    if (actions) actions.style.display = '';
    if (meta) meta.textContent = `Geprüft: ${new Date(data.checkedAt).toLocaleString('de-DE')}`;
  } catch (e) {
    banner.textContent = 'Fehler beim Prüfen: ' + e.message;
  }
}

async function applySystemUpdates() {
  const banner = document.getElementById('systemUpdatesBanner');
  const actions = document.getElementById('systemUpdatesActions');
  const btn = document.getElementById('applySystemUpdatesBtn');
  if (!banner) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Updates werden installiert...'; }
  banner.innerHTML = '<span style="color:var(--c-amber-600);">Updates werden installiert — das kann einige Minuten dauern...</span>';
  try {
    const r = await apiFetch('/api/admin/system/updates/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    const data = await r.json();
    if (data.ok) {
      banner.innerHTML = `<span style="color:var(--ok);">${data.upgraded} Pakete aktualisiert.</span>`;
      if (actions) actions.style.display = 'none';
      const list = document.getElementById('systemUpdatesList');
      if (list) list.style.display = 'none';
    } else {
      banner.innerHTML = `<span style="color:var(--err);">Fehler: ${escapeHtml(data.error || 'unbekannt')}</span>`;
    }
  } catch (e) {
    banner.innerHTML = `<span style="color:var(--err);">Update fehlgeschlagen: ${escapeHtml(e.message)}</span>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Alle Updates installieren'; }
  }
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

function renderVpnUploadPanel() {
  const panel = document.createElement('section');
  panel.className = 'config-group';
  panel.dataset.accent = 'purple';

  const kicker = document.createElement('div');
  kicker.className = 'config-group-kicker';
  kicker.textContent = 'VPN-Profil hochladen';
  kicker.style.color = 'var(--node-vpn, #7F77DD)';
  panel.appendChild(kicker);

  const desc = document.createElement('p');
  desc.style.cssText = 'font-size:0.78rem;opacity:0.7;padding:0 14px 8px;margin:0;';
  desc.textContent = '.ovpn- oder WireGuard .conf-Datei hochladen. Bei OpenVPN optional separate Zertifikate. Private Keys werden sicher gespeichert und nie per API zurückgegeben.';
  panel.appendChild(desc);

  const form = document.createElement('div');
  form.style.cssText = 'padding:0 14px 14px;';
  form.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px;">
      <label style="font-size:0.78rem;font-weight:600;">VPN-Konfiguration (.ovpn / .conf)</label>
      <input type="file" id="vpnOvpnFile" accept=".ovpn,.conf" style="font-size:0.78rem;">
      <label style="font-size:0.78rem;font-weight:600;margin-top:4px;">Optionale Dateien</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        <div><span style="font-size:0.7rem;opacity:0.6;">ca.crt</span><input type="file" id="vpnCaFile" accept=".crt,.pem" style="font-size:0.7rem;width:100%;"></div>
        <div><span style="font-size:0.7rem;opacity:0.6;">client.crt</span><input type="file" id="vpnCertFile" accept=".crt,.pem" style="font-size:0.7rem;width:100%;"></div>
        <div><span style="font-size:0.7rem;opacity:0.6;">client.key</span><input type="file" id="vpnKeyFile" accept=".key,.pem" style="font-size:0.7rem;width:100%;"></div>
        <div><span style="font-size:0.7rem;opacity:0.6;">ta.key / ipsec.secrets</span><input type="file" id="vpnTaFile" accept=".key,.pem,.secrets" style="font-size:0.7rem;width:100%;"></div>
      </div>
      <button id="vpnUploadBtn" type="button" class="btn btn-small" style="margin-top:6px;background:var(--node-vpn,#7F77DD);color:#fff;align-self:flex-start;">
        Hochladen
      </button>
      <div id="vpnUploadResult" style="font-size:0.75rem;min-height:1.2em;"></div>
    </div>
  `;
  panel.appendChild(form);

  // VPN status summary
  const statusDiv = document.createElement('div');
  statusDiv.id = 'vpnSettingsStatus';
  statusDiv.style.cssText = 'padding:0 14px 14px;font-size:0.78rem;';
  panel.appendChild(statusDiv);

  // VPN action buttons
  const actionsDiv = document.createElement('div');
  actionsDiv.style.cssText = 'padding:0 14px 10px;display:flex;gap:8px;align-items:center;';
  actionsDiv.innerHTML = `
    <button id="vpnSettingsStart" class="btn btn-small" style="background:var(--node-vpn,#7F77DD);color:#fff;">Verbinden</button>
    <button id="vpnSettingsStop" class="btn btn-small btn-ghost" style="border-color:var(--node-vpn,#7F77DD);color:var(--node-vpn,#7F77DD);">Trennen</button>
    <button id="vpnSettingsRestart" class="btn btn-small btn-ghost" style="border-color:var(--node-vpn,#7F77DD);color:var(--node-vpn,#7F77DD);">Reconnect</button>
    <span id="vpnSettingsActionResult" style="font-size:0.72rem;margin-left:6px;"></span>
  `;
  panel.appendChild(actionsDiv);

  async function vpnSettingsAction(action, btn) {
    const resultEl = document.getElementById('vpnSettingsActionResult');
    btn.disabled = true;
    if (resultEl) { resultEl.textContent = '...'; resultEl.style.color = ''; }
    try {
      const r = await apiFetch('/api/vpn/' + action, { method: 'POST' });
      const out = await r.json();
      if (resultEl) {
        resultEl.textContent = out.ok ? (action === 'stop' ? 'Getrennt' : 'OK') : (out.error || 'Fehler');
        resultEl.style.color = out.ok ? 'var(--ok)' : 'var(--err)';
      }
      refreshVpnSettingsStatus();
    } catch (e) {
      if (resultEl) { resultEl.textContent = e.message; resultEl.style.color = 'var(--err)'; }
    } finally {
      btn.disabled = false;
    }
  }

  setTimeout(() => {
    document.getElementById('vpnSettingsStart')?.addEventListener('click', function() { vpnSettingsAction('start', this); });
    document.getElementById('vpnSettingsStop')?.addEventListener('click', function() { vpnSettingsAction('stop', this); });
    document.getElementById('vpnSettingsRestart')?.addEventListener('click', function() { vpnSettingsAction('restart', this); });
  }, 0);

  // fetch VPN status
  function refreshVpnSettingsStatus() {
    apiFetch('/api/vpn/status').then(r => r.json()).then(vpn => {
      const labels = { connected: 'Verbunden', connecting: 'Verbinde...', disconnected: 'Getrennt', error: 'Fehler' };
      const colors = { connected: 'var(--ok,#22c55e)', error: 'var(--err,#ef4444)', connecting: 'var(--c-amber-600,#d97706)', disconnected: 'var(--flow-text-muted,#9ca3af)' };
      let html = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${colors[vpn.status] || '#888'};margin-right:6px;"></span>`;
      html += `<strong style="color:${colors[vpn.status] || '#888'};">${labels[vpn.status] || vpn.status || 'unbekannt'}</strong>`;
      if (vpn.tunIp) html += ` | IP: ${escapeHtml(vpn.tunIp)}`;
      if (vpn.profileName) html += ` | Profil: ${escapeHtml(vpn.profileName)}`;
      if (vpn.uptimeSeconds > 0) {
        const h = Math.floor(vpn.uptimeSeconds / 3600);
        const m = Math.floor((vpn.uptimeSeconds % 3600) / 60);
        html += ` | Uptime: ${h > 0 ? h + 'h ' : ''}${m}m`;
      }
      if (vpn.reconnectAttempts > 0) html += ` | Reconnects: ${vpn.reconnectAttempts}`;
      if (vpn.certDaysRemaining != null && vpn.certDaysRemaining <= 30) {
        html += ` | <span style="color:var(--c-amber-600);">Zertifikat: ${vpn.certDaysRemaining} Tage</span>`;
      }
      if (vpn.lastError) html += ` | <span style="color:var(--err);">${escapeHtml(vpn.lastError)}</span>`;
      statusDiv.innerHTML = html;
    }).catch(() => {
      statusDiv.textContent = 'VPN-Status konnte nicht abgerufen werden.';
    });
  }
  refreshVpnSettingsStatus();

  // fetch VPN config details
  const configDiv = document.createElement('div');
  configDiv.style.cssText = 'padding:0 14px 14px;font-size:0.75rem;';
  panel.appendChild(configDiv);

  apiFetch('/api/vpn/config').then(r => r.json()).then(cfg => {
    if (!cfg || !cfg.configExists) {
      configDiv.innerHTML = '<span style="opacity:0.5;">Kein VPN-Profil importiert.</span>';
      return;
    }
    if (!cfg.fields || !cfg.fields.length) return;

    let html = '<div style="margin-top:6px;border:1px solid var(--flow-border,#333);border-radius:8px;overflow:hidden;">';
    html += '<div style="padding:6px 10px;font-weight:600;font-size:0.72rem;background:var(--flow-surface,#1a1a2e);color:var(--node-vpn,#7F77DD);">Importierte VPN-Konfiguration</div>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:0.72rem;">';
    cfg.fields.forEach((f, i) => {
      const bg = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)';
      const labelStyle = f.forced ? 'opacity:0.6;' : '';
      const valStyle = f.warn ? 'color:var(--c-amber-600);font-weight:600;' : f.forced ? 'opacity:0.6;' : '';
      const badge = f.forced ? ' <span style="font-size:0.6rem;opacity:0.5;background:var(--node-vpn,#7F77DD);color:#fff;padding:1px 4px;border-radius:3px;">forced</span>' : '';
      html += `<tr style="background:${bg};"><td style="padding:3px 10px;white-space:nowrap;${labelStyle}">${escapeHtml(f.key)}${badge}</td><td style="padding:3px 10px;font-family:monospace;${valStyle}">${escapeHtml(f.value)}</td></tr>`;
    });
    html += '</table></div>';
    configDiv.innerHTML = html;
  }).catch(() => {});

  // upload handler (deferred to avoid event timing issues)
  setTimeout(() => {
    document.getElementById('vpnUploadBtn')?.addEventListener('click', handleVpnUpload);
  }, 0);

  return panel;
}

async function handleVpnUpload() {
  const resultEl = document.getElementById('vpnUploadResult');
  const ovpnInput = document.getElementById('vpnOvpnFile');
  if (!ovpnInput?.files?.length) {
    if (resultEl) resultEl.textContent = 'Bitte .ovpn- oder .conf-Datei auswaehlen.';
    return;
  }

  const formData = new FormData();
  formData.append('config', ovpnInput.files[0]);

  const caInput = document.getElementById('vpnCaFile');
  if (caInput?.files?.length) formData.append('ca', caInput.files[0]);
  const certInput = document.getElementById('vpnCertFile');
  if (certInput?.files?.length) formData.append('cert', certInput.files[0]);
  const keyInput = document.getElementById('vpnKeyFile');
  if (keyInput?.files?.length) formData.append('key', keyInput.files[0]);
  const taInput = document.getElementById('vpnTaFile');
  if (taInput?.files?.length) {
    const file = taInput.files[0];
    // Route to correct field based on filename
    if (file.name === 'ipsec.secrets' || file.name.endsWith('.secrets')) {
      formData.append('secrets', file);
    } else {
      formData.append('ta', file);
    }
  }

  if (resultEl) resultEl.textContent = 'Hochladen...';

  try {
    const r = await apiFetch('/api/vpn/config/upload', { method: 'POST', body: formData });
    const out = await r.json();
    if (resultEl) {
      resultEl.textContent = out.ok
        ? `Profil "${out.profile}" importiert.`
        : `Fehler: ${(out.errors || [out.error]).join(', ')}`;
      resultEl.style.color = out.ok ? 'var(--ok)' : 'var(--err)';
    }
  } catch (e) {
    if (resultEl) { resultEl.textContent = `Upload fehlgeschlagen: ${e.message}`; resultEl.style.color = 'var(--err)'; }
  }
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
    forecastStringsDraft = clone(currentRawConfig?.forecast?.pv?.strings || []);
    renderSettingsShell();
    updateSaveBar();
    setBanner('Änderungen verworfen.', 'info');
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

  // System Updates (OS packages)
  document.getElementById('checkSystemUpdatesBtn')?.addEventListener('click', checkSystemUpdates);
  document.getElementById('applySystemUpdatesBtn')?.addEventListener('click', applySystemUpdates);
  document.getElementById('rebootSystemBtn')?.addEventListener('click', async () => {
    if (!confirm('System wirklich neu starten? DVhub ist danach kurz nicht erreichbar.')) return;
    const resultEl = document.getElementById('rebootResult');
    if (resultEl) { resultEl.textContent = 'Neustart...'; resultEl.style.color = 'var(--c-amber-600)'; }
    try {
      await apiFetch('/api/admin/system/reboot', { method: 'POST' });
      if (resultEl) { resultEl.textContent = 'System startet neu — Seite wird in 30s neu geladen...'; }
      setTimeout(() => window.location.reload(), 30000);
    } catch (e) {
      if (resultEl) { resultEl.textContent = 'Fehler: ' + e.message; resultEl.style.color = 'var(--err)'; }
    }
  });
  loadSystemInfo();

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
    banner.className = `config-banner ${ok ? 'success' : 'warn'}`;
    banner.textContent = ok
      ? `Verbunden mit ${status.victron?.host || 'Victron'}`
      : 'Keine Verbindung zum Victron-System.';
  }).catch(() => {
    const banner = document.getElementById('connectionBanner');
    if (banner) {
      banner.className = 'config-banner error';
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
      // Auto-load ML status when switching to ML tab
      if (target === 'ml') {
        initMlTab();
      }
      // Auto-load health + check for updates when switching to System tab
      if (target === 'system') {
        loadHealth().catch(() => {});
        if (typeof checkForUpdate === 'function') {
          const lastCheck = Number(sessionStorage.getItem('dvhub_update_check_at') || 0);
          const cooldownMs = 10 * 60 * 1000;
          if (Date.now() - lastCheck > cooldownMs) {
            sessionStorage.setItem('dvhub_update_check_at', String(Date.now()));
            checkForUpdate().catch(() => {});
          }
        }
      }
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

/* =========================================================================
   Phase 05 — ML & AI Tab (D-27)
   ========================================================================= */
var mlMaeSparklineChart = null;
var mlTabInitialized = false;

function initMlTab() {
  // Also handle direct URL hash navigation
  if (location.hash === '#ml') {
    var tab = document.querySelector('.settings-tab[data-tab="ml"]');
    if (tab && !tab.classList.contains('is-active')) {
      tab.click();
      return; // click triggers initMlTab again via the tab handler
    }
  }

  if (!apiFetch) return;

  apiFetch('/api/ml/status').then(function (res) {
    if (!res.ok) throw new Error('ML status unavailable');
    return res.json();
  }).then(function (status) {
    renderMlStatus(status);
  }).catch(function () {
    var banner = document.getElementById('mlModelType');
    if (banner) banner.textContent = '--';
  });

  apiFetch('/api/ml/accuracy').then(function (res) {
    if (!res.ok) throw new Error('ML accuracy unavailable');
    return res.json();
  }).then(function (data) {
    renderMaeSparkline(Array.isArray(data) ? data : []);
  }).catch(function () {
    // Sparkline stays empty
  });
}

function formatMlDate(ts) {
  if (!ts) return '--';
  try {
    var d = new Date(ts);
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return '--';
  }
}

function renderMlStatus(status) {
  if (!status) return;

  // Model Status card
  var modelTypeEl = document.getElementById('mlModelType');
  if (modelTypeEl) modelTypeEl.textContent = status.modelType || '--';

  var modelVersionEl = document.getElementById('mlModelVersion');
  if (modelVersionEl) modelVersionEl.textContent = 'v' + (status.modelVersion || 0);

  var lastTrainEl = document.getElementById('mlLastTrain');
  if (lastTrainEl) lastTrainEl.textContent = status.lastTraining ? formatMlDate(status.lastTraining) : '--';

  var nextTrainEl = document.getElementById('mlNextTrain');
  if (nextTrainEl) nextTrainEl.textContent = status.nextTraining ? formatMlDate(status.nextTraining) : '--';

  // MAE values
  var mae7dEl = document.getElementById('mlMae7d');
  if (mae7dEl) mae7dEl.textContent = (status.mae != null) ? String(status.mae) : '--';

  var mae30dEl = document.getElementById('mlMae30d');
  if (mae30dEl) mae30dEl.textContent = (status.mae30d != null) ? String(status.mae30d) : (status.mae != null ? String(status.mae) : '--');

  // Tier Features
  renderTierFeatures(status);

  // Training Log
  renderTrainingLog(status);

  // LLM group (Tier 3 only)
  var llmGroup = document.getElementById('mlLlmGroup');
  if (llmGroup) {
    if (status.tier >= 3) {
      llmGroup.hidden = false;
      var llmModelNameEl = document.getElementById('llmModelName');
      if (llmModelNameEl) {
        // Read from config if /api/ml/status doesn't include llmModel
        llmModelNameEl.textContent = status.llmModel || (window.__dvhubConfig && window.__dvhubConfig.llm && window.__dvhubConfig.llm.llmModel) || 'LLM';
      }
      var llmStatusEl = document.getElementById('llmStatus');
      if (llmStatusEl) llmStatusEl.textContent = status.llmStatus || '--';

      var llmMsgCountEl = document.getElementById('llmMsgCount');
      if (llmMsgCountEl) llmMsgCountEl.textContent = (status.llmMsgCount != null) ? String(status.llmMsgCount) : '--';

      var llmInferenceMsEl = document.getElementById('llmInferenceMs');
      if (llmInferenceMsEl) llmInferenceMsEl.textContent = (status.llmInferenceMs != null) ? (status.llmInferenceMs + ' ms') : '--';
    } else {
      llmGroup.hidden = true;
    }
  }
}

// Translate backend feature keys to German UI labels
var TIER_FEATURE_LABELS = {
  sql_load_forecast: 'SQL Lastvorhersage',
  pvlib_batch: 'pvlib (Batch)',
  statsforecast: 'StatsForecast',
  ml_correction: 'ML-Korrektur (PV)',
  ml_training: 'ML-Training (taeglich)',
  statsforecast_mstl: 'StatsForecast MSTL',
  persistent_python: 'Persistenter Python-Prozess',
  edge_llm: 'Edge-LLM Nachrichten'
};

function renderTierFeatures(status) {
  var container = document.getElementById('mlTierFeatures');
  if (!container) return;

  var tier = status.tier || 1;
  var tierFeatures = status.tierFeatures || [];

  if (tierFeatures.length === 0) {
    container.innerHTML = '<div class="detail-row"><span class="detail-key" style="color:rgba(232,234,240,0.3);">Keine Tier-Informationen verfuegbar</span></div>';
    return;
  }

  container.innerHTML = tierFeatures.map(function (f) {
    // Normalize backend shape { feature, status, requiredTier }
    var key = f.feature || f.name || '';
    var featureLabel = TIER_FEATURE_LABELS[key] || key || 'Unbekannt';
    var rawStatus = f.status || 'inactive';
    var minTier = f.requiredTier != null ? f.requiredTier : (f.minTier || 1);

    var label, color, textDeco = 'none';
    if (rawStatus === 'active') {
      label = 'aktiv';
      color = 'var(--ok)';
    } else if (rawStatus === 'inactive') {
      if (tier < minTier) {
        label = 'nicht verfuegbar (Tier ' + minTier + '+)';
        color = 'var(--flow-text-dim)';
        textDeco = 'line-through';
      } else {
        label = 'inaktiv';
        color = 'var(--flow-text-muted)';
      }
    } else if (rawStatus === 'collecting') {
      label = 'sammelt Daten';
      color = 'var(--warn)';
    } else {
      label = rawStatus;
      color = 'var(--flow-text-muted)';
    }

    return '<div class="detail-row">' +
      '<span class="detail-key">' + escapeHtml(featureLabel) + '</span>' +
      '<span class="detail-val" style="color:' + color + ';text-decoration:' + textDeco + ';">' + escapeHtml(label) + '</span>' +
      '</div>';
  }).join('');
}

function renderTrainingLog(status) {
  var container = document.getElementById('mlTrainingLog');
  if (!container) return;

  var log = status.trainingLog || [];
  if (log.length === 0) {
    container.innerHTML = '<div class="detail-row"><span class="detail-key" style="color:rgba(232,234,240,0.3);">Noch keine Trainingslaeufe</span></div>';
    return;
  }

  // Show last 5 entries
  var entries = log.slice(-5).reverse();
  container.innerHTML = entries.map(function (entry) {
    var ts = formatMlDate(entry.ts || entry.date);
    var model = escapeHtml(entry.model || entry.modelType || '--');
    var version = entry.version || entry.modelVersion || '?';
    var mae = entry.mae != null ? entry.mae + 'W' : '--';
    var result = entry.status || entry.result || 'OK';
    var color;

    if (result === 'OK' || result === 'ok' || result === 'success') {
      color = 'var(--ok)';
    } else if (result === 'Rollback' || result === 'rollback') {
      color = 'var(--warn)';
    } else {
      color = 'var(--danger)';
      result = 'Fehler';
    }

    return '<div class="detail-row">' +
      '<span class="detail-key" style="font-family:\'JetBrains Mono\',monospace;font-size:10px;">' + escapeHtml(ts) + '</span>' +
      '<span class="detail-val">' + model + ' v' + escapeHtml(String(version)) + ' &middot; MAE ' + escapeHtml(mae) +
      ' <span style="color:' + color + ';font-weight:600;">' + escapeHtml(result) + '</span></span>' +
      '</div>';
  }).join('');
}

function renderMaeSparkline(data) {
  var canvas = document.getElementById('mlMaeSparkline');
  if (!canvas || typeof Chart === 'undefined') return;

  var maeValues = data.map(function (d) { return d.mae || 0; });
  var labels = data.map(function (d) { return d.date || ''; });

  var config = {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        data: maeValues,
        borderColor: '#5a6a8a',
        backgroundColor: 'rgba(90, 106, 138, 0.08)',
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.3,
        fill: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(11, 15, 26, 0.95)',
          titleColor: '#e8eaf0',
          bodyColor: '#c8cdd8',
          borderColor: 'rgba(99, 102, 241, 0.3)',
          borderWidth: 1,
          padding: 6,
          cornerRadius: 4,
          bodyFont: { family: 'JetBrains Mono', size: 10 },
          callbacks: {
            label: function (ctx) { return 'MAE: ' + ctx.parsed.y.toFixed(1) + ' W'; }
          }
        }
      },
      scales: {
        x: { display: false },
        y: { display: false }
      }
    }
  };

  if (mlMaeSparklineChart) {
    mlMaeSparklineChart.data = config.data;
    mlMaeSparklineChart.update('none');
  } else {
    mlMaeSparklineChart = new Chart(canvas, config);
  }
}
