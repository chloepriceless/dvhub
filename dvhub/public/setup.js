const common = typeof window !== 'undefined' ? window.DVhubCommon || {} : {};
const { apiFetch, setStoredApiToken } = common;

let setupDefinition = null;

const REVIEW_STEP_ID = 'review';

let setupWizardState = createSetupWizardState();
let setupDiscoveryStates = {};

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function getParts(path) {
  return String(path).split('.').filter(Boolean);
}

function hasPath(obj, path) {
  let current = obj;
  for (const part of getParts(path)) {
    if (!current || typeof current !== 'object' || !(part in current)) return false;
    current = current[part];
  }
  return true;
}

function getPath(obj, path, fallback = undefined) {
  let current = obj;
  for (const part of getParts(path)) {
    if (!current || typeof current !== 'object' || !(part in current)) return fallback;
    current = current[part];
  }
  return current;
}

function setPath(obj, path, value) {
  const parts = getParts(path);
  let current = obj;
  while (parts.length > 1) {
    const part = parts.shift();
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts[0]] = value;
}

function inferSetupFieldValueType(field) {
  if (field.type === 'number') return 'number';
  if (field.type === 'boolean') return 'boolean';
  if (field.type === 'select' && Array.isArray(field.options) && field.options.length && field.options.every((option) => typeof option.value === 'number')) return 'number';
  return 'string';
}

function getSetupStepDefinitions(definitionLike = setupDefinition) {
  return (definitionLike?.setupWizard?.steps || [])
    .map((step, index) => ({
      ...step,
      index: Number.isInteger(step.index) ? step.index : index
    }))
    .sort((left, right) => left.index - right.index);
}

function getSetupFieldDefinitions(definitionLike = setupDefinition) {
  return (definitionLike?.fields || [])
    .filter((field) => field?.setup?.stepId)
    .map((field) => ({
      ...field,
      help: field.setup?.help || field.help || '',
      valueType: inferSetupFieldValueType(field)
    }))
    .sort((left, right) => {
      if (left.setup.stepId !== right.setup.stepId) return left.setup.stepId.localeCompare(right.setup.stepId);
      return (left.setup.order || 0) - (right.setup.order || 0);
    });
}

function resolveSetupStepId(stepId, steps = getSetupStepDefinitions()) {
  const validIds = new Set((steps || []).map((step) => step.id));
  if (validIds.has(stepId)) return stepId;
  return steps[0]?.id || '';
}

function getSetupFieldsForStep(stepId, definitionLike = setupDefinition) {
  return getSetupFieldDefinitions(definitionLike).filter((field) => field.setup?.stepId === stepId);
}

function matchesSetupVisibilityRule(state, rule) {
  if (!rule?.path) return true;
  return resolveWizardValue(state, rule.path) === rule.equals;
}

function isSetupFieldVisible(state, field) {
  const setup = field?.setup || {};
  if (Array.isArray(setup.visibleWhenTransport) && setup.visibleWhenTransport.length && !setup.visibleWhenTransport.includes(getSetupTransportMode(state))) return false;
  if (setup.visibleWhenPath && !matchesSetupVisibilityRule(state, setup.visibleWhenPath)) return false;
  if (setup.hiddenWhenPath && matchesSetupVisibilityRule(state, setup.hiddenWhenPath)) return false;
  return true;
}

function getVisibleSetupFieldsForStep(state, stepId) {
  return getSetupFieldsForStep(stepId, state?.definition || setupDefinition).filter((field) => isSetupFieldVisible(state, field));
}

function buildSetupSteps(definitionLike = setupDefinition) {
  const steps = getSetupStepDefinitions(definitionLike);
  const reviewStep = steps.find((step) => step.id === REVIEW_STEP_ID) || {
    id: REVIEW_STEP_ID,
    index: steps.length,
    label: `Schritt ${steps.length + 1}`,
    title: 'Prüfen & speichern',
    description: 'Kontrolliere die wichtigsten Werte und die wirksamen Defaults, bevor DVhub die Config speichert.'
  };
  return [...steps, reviewStep].map((step, index) => {
    const fields = getSetupFieldsForStep(step.id, definitionLike);
    return {
      ...step,
      index,
      fields: fields.map((field) => field.path),
      fieldCount: fields.length
    };
  });
}

function resolveWizardValue(state, path, fallback = undefined) {
  if (hasPath(state?.draftConfig, path)) return getPath(state.draftConfig, path);
  if (hasPath(state?.effectiveConfig, path)) return getPath(state.effectiveConfig, path);
  return fallback;
}

function createSetupDiscoveryState({
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

function getSetupFieldDiscoveryState(fieldPath) {
  return setupDiscoveryStates[fieldPath] || createSetupDiscoveryState();
}

function setSetupFieldDiscoveryState(fieldPath, state) {
  setupDiscoveryStates = {
    ...setupDiscoveryStates,
    [fieldPath]: state
  };
}

function resolveSetupDiscoveryManufacturer(state, field) {
  const manufacturerPath = field?.discovery?.manufacturerPath;
  if (!manufacturerPath) return '';
  return String(resolveWizardValue(state, manufacturerPath, '') || '').trim();
}

function buildSetupFieldRenderModel(state, field) {
  const value = resolveWizardValue(state, field.path, field.type === 'boolean' ? false : '');
  if (!field?.discovery) {
    return {
      value,
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

  const manufacturer = resolveSetupDiscoveryManufacturer(state, field);
  const discoveryState = createSetupDiscoveryState({
    ...getSetupFieldDiscoveryState(field.path),
    manufacturer
  });

  return {
    value,
    discovery: {
      ...discoveryState,
      visible: true,
      actionLabel: field.discovery.actionLabel || 'Find System IP'
    }
  };
}

function getSetupTransportMode(state) {
  return resolveWizardValue(state, 'victron.transport', 'modbus') === 'mqtt' ? 'mqtt' : 'modbus';
}

function buildValidationResult(summary, steps = []) {
  const fields = {};
  const stepState = {};
  for (const step of steps) {
    stepState[step.id] = { valid: true, errors: [] };
  }
  for (const entry of summary) {
    if (!stepState[entry.stepId]) stepState[entry.stepId] = { valid: true, errors: [] };
    stepState[entry.stepId].valid = false;
    stepState[entry.stepId].errors.push(entry.message);
    if (!fields[entry.path]) fields[entry.path] = [];
    fields[entry.path].push(entry.message);
  }
  return {
    fields,
    steps: stepState,
    summary,
    isBlocking: summary.length > 0
  };
}

function pushValidationError(summary, stepId, path, message) {
  summary.push({ stepId, path, message });
}

function isBlankValue(value) {
  return value === '' || value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function validateIntegerInRange(value, min, max) {
  if (isBlankValue(value)) return false;
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= min && normalized <= max;
}

function validateSetupWizardState(state) {
  const steps = buildSetupSteps(state?.definition || setupDefinition);
  const summary = [];
  const requireText = (stepId, path, message) => {
    if (String(resolveWizardValue(state, path, '') || '').trim()) return;
    pushValidationError(summary, stepId, path, message);
  };
  const requireInteger = (stepId, path, min, max, message) => {
    if (validateIntegerInRange(resolveWizardValue(state, path), min, max)) return;
    pushValidationError(summary, stepId, path, message);
  };
  const requireOption = (stepId, path, options, message) => {
    if (options.includes(resolveWizardValue(state, path))) return;
    pushValidationError(summary, stepId, path, message);
  };

  requireInteger('basics', 'httpPort', 1, 65535, 'Bitte einen gültigen Port zwischen 1 und 65535 eingeben.');

  requireOption('transport', 'manufacturer', ['victron'], 'Bitte einen gültigen Hersteller wählen.');
  requireText('transport', 'victron.host', 'Bitte den Anlagen-Host oder DNS-Namen angeben.');

  requireText('dv', 'modbusListenHost', 'Bitte den Modbus-Listen-Host angeben.');
  requireInteger('dv', 'modbusListenPort', 1, 65535, 'Bitte einen gültigen Port zwischen 1 und 65535 eingeben.');
  requireOption('dv', 'gridPositiveMeans', ['feed_in', 'grid_import'], 'Bitte eine gültige Vorzeichenlogik wählen.');

  requireText('services', 'schedule.timezone', 'Bitte eine Zeitzone für den Zeitplan angeben.');
  if (resolveWizardValue(state, 'epex.enabled', false)) {
    requireText('services', 'epex.bzn', 'Bitte die BZN für den EPEX-Dienst angeben.');
  }
  return {
    ...state,
    definition: clone(state?.definition || setupDefinition || {}),
    steps,
    stepOrder: steps.map((step) => step.id),
    activeStepId: resolveSetupStepId(state?.activeStepId, steps),
    transportMode: getSetupTransportMode(state),
    validation: buildValidationResult(summary, steps)
  };
}

function createSetupWizardState(payload = {}) {
  const definition = clone(payload.definition || setupDefinition || {});
  const steps = buildSetupSteps(definition);
  const initialStepId = resolveSetupStepId(payload.activeStepId, steps);
  const state = {
    definition,
    draftConfig: clone(
      payload.config && Object.keys(payload.config).length > 0
        ? payload.config
        : payload.effectiveConfig || {}
    ),
    effectiveConfig: clone(payload.effectiveConfig || {}),
    meta: clone(payload.meta || {}),
    steps,
    stepOrder: steps.map((step) => step.id),
    activeStepId: initialStepId,
    visitedStepIds: Array.from(new Set(initialStepId ? [initialStepId] : [])),
    completedStepIds: [],
    transportMode: 'modbus',
    validation: buildValidationResult([], steps)
  };
  return validateSetupWizardState(state);
}

function updateSetupDraftValue(state, path, value) {
  const nextDraft = clone(state?.draftConfig || {});
  setPath(nextDraft, path, value);
  if (path === 'schedule.timezone') setPath(nextDraft, 'epex.timezone', value);
  return validateSetupWizardState({
    ...state,
    draftConfig: nextDraft
  });
}

function applyDiscoveredSystemToSetupState({ state, fieldPath, selectedSystem } = {}) {
  const nextState = updateSetupDraftValue(state, fieldPath, selectedSystem?.ipv4 || selectedSystem?.ip || selectedSystem?.ipv6 || '');
  setSetupFieldDiscoveryState(fieldPath, createSetupDiscoveryState({
    ...getSetupFieldDiscoveryState(fieldPath),
    manufacturer: resolveWizardValue(nextState, 'manufacturer', ''),
    selectedSystemId: selectedSystem?.id || ''
  }));
  return nextState;
}

function formatSetupDiscoveredSystemOption(system = {}) {
  const parts = [system.label || 'System', system.host || '-'];
  if (system.ipv4) parts.push(`IPv4: ${system.ipv4}`);
  if (system.ipv6) parts.push(`IPv6: ${system.ipv6}`);
  if (!system.ipv4 && !system.ipv6 && system.ip) parts.push(system.ip);
  return parts.join(' • ');
}

function setActiveSetupStep(state, requestedStepId) {
  const steps = state?.steps?.length ? state.steps : buildSetupSteps(state?.definition || setupDefinition);
  const activeStepId = resolveSetupStepId(requestedStepId, steps);
  return {
    ...state,
    steps,
    stepOrder: steps.map((step) => step.id),
    activeStepId,
    visitedStepIds: Array.from(new Set([...(state?.visitedStepIds || []), activeStepId]))
  };
}

function getCurrentStepIndex(state) {
  return Math.max(0, (state?.stepOrder || []).indexOf(state?.activeStepId));
}

function goToNextSetupStep(state) {
  const validatedState = validateSetupWizardState(state);
  const currentStepId = validatedState.activeStepId;
  if (!validatedState.validation.steps[currentStepId]?.valid) return validatedState;
  const currentIndex = getCurrentStepIndex(validatedState);
  const nextStepId = validatedState.stepOrder[currentIndex + 1] || currentStepId;
  if (nextStepId === REVIEW_STEP_ID && validatedState.validation.isBlocking) return validatedState;
  return {
    ...setActiveSetupStep(validatedState, nextStepId),
    completedStepIds: Array.from(new Set([...(validatedState.completedStepIds || []), currentStepId]))
  };
}

function goToPreviousSetupStep(state) {
  const currentIndex = getCurrentStepIndex(state);
  const previousStepId = state?.stepOrder?.[currentIndex - 1] || state?.activeStepId;
  return setActiveSetupStep(state, previousStepId);
}

function formatReviewValue(value, fallback = 'Nicht gesetzt') {
  if (isBlankValue(value)) return fallback;
  if (typeof value === 'boolean') return value ? 'Aktiv' : 'Deaktiviert';
  return String(value);
}

function hasOwnDraftValue(state, path) {
  return hasPath(state?.draftConfig, path) && !isBlankValue(getPath(state?.draftConfig, path));
}

function collectInheritedMeterNotes(state) {
  const effectiveHost = resolveWizardValue(state, 'meter.host', '');
  const effectivePort = resolveWizardValue(state, 'meter.port', '');
  const effectiveUnitId = resolveWizardValue(state, 'meter.unitId', '');
  const effectiveTimeout = resolveWizardValue(state, 'meter.timeoutMs', '');
  const notes = [];

  if (!hasOwnDraftValue(state, 'meter.host') && !isBlankValue(effectiveHost)) {
    notes.push(`Meter Host folgt automatisch der Victron-Verbindung: ${effectiveHost}.`);
  }
  if (!hasOwnDraftValue(state, 'meter.port') && !isBlankValue(effectivePort)) {
    notes.push(`Meter Port bleibt auf dem wirksamen Standard ${effectivePort}.`);
  }
  if (!hasOwnDraftValue(state, 'meter.unitId') && !isBlankValue(effectiveUnitId)) {
    notes.push(`Meter Unit ID übernimmt den wirksamen Wert ${effectiveUnitId}.`);
  }
  if (!hasOwnDraftValue(state, 'meter.timeoutMs') && !isBlankValue(effectiveTimeout)) {
    notes.push(`Meter Timeout bleibt beim wirksamen Wert ${effectiveTimeout} ms.`);
  }

  return notes;
}

function collectInheritedDvControlNotes(state) {
  const effectiveHost = resolveWizardValue(state, 'dvControl.feedExcessDcPv.host', '');
  const effectivePort = resolveWizardValue(state, 'dvControl.feedExcessDcPv.port', '');
  const effectiveUnitId = resolveWizardValue(state, 'dvControl.feedExcessDcPv.unitId', '');
  const notes = [];

  const usesInheritedConnection = !hasOwnDraftValue(state, 'dvControl.feedExcessDcPv.host')
    && !hasOwnDraftValue(state, 'dvControl.feedExcessDcPv.port')
    && !hasOwnDraftValue(state, 'dvControl.feedExcessDcPv.unitId')
    && !hasOwnDraftValue(state, 'dvControl.dontFeedExcessAcPv.host')
    && !hasOwnDraftValue(state, 'dvControl.dontFeedExcessAcPv.port')
    && !hasOwnDraftValue(state, 'dvControl.dontFeedExcessAcPv.unitId');

  if (usesInheritedConnection && !isBlankValue(effectiveHost)) {
    const target = `${effectiveHost}${isBlankValue(effectivePort) ? '' : `:${effectivePort}`}`;
    const unit = isBlankValue(effectiveUnitId) ? '' : ` (Unit ${effectiveUnitId})`;
    notes.push(`Die DV-Register folgen automatisch der wirksamen Victron-Verbindung ${target}${unit}.`);
  }

  return notes;
}

function buildInheritedSetupInfoSections(state) {
  const sections = [];
  const meterNotes = collectInheritedMeterNotes(state);
  const dvControlNotes = collectInheritedDvControlNotes(state);

  if (meterNotes.length) {
    sections.push({
      id: 'meter',
      title: 'Meter-Verbindung',
      notes: meterNotes
    });
  }
  if (dvControlNotes.length) {
    sections.push({
      id: 'dvControl',
      title: 'DV-Register',
      notes: dvControlNotes
    });
  }

  return sections;
}

function validateSetupSubmissionConfig(config, state = setupWizardState) {
  const baseState = state || setupWizardState || {};
  return createSetupWizardState({
    definition: baseState.definition || setupDefinition,
    config: clone(config || {}),
    effectiveConfig: clone(config || {}),
    meta: clone(baseState.meta || {}),
    activeStepId: baseState.activeStepId
  });
}

function describeRestartPath(path) {
  if (path === 'httpPort') return 'Webserver-Port';
  if (path === 'modbusListenHost' || path === 'modbusListenPort') return 'DV Modbus Proxy';
  if (path === 'manufacturer') return 'Herstellerprofil';
  if (path === 'victron.host') return 'Anlagenadresse';
  return path;
}

function buildSetupSaveOutcome(payload, source = 'setup') {
  const warnings = Array.isArray(payload?.meta?.warnings) ? payload.meta.warnings : [];
  const restartItems = Array.from(new Set((Array.isArray(payload?.restartRequiredPaths) ? payload.restartRequiredPaths : []).map(describeRestartPath)));
  const title = source === 'import' ? 'Config importiert' : 'Setup gespeichert';
  const kind = payload?.restartRequired || warnings.length ? 'warn' : 'success';
  const summary = payload?.restartRequired
    ? 'Ein Teil der Änderungen ist gespeichert, wird aber erst nach einem Dienst-Neustart oder einer neuen Verbindung wirksam.'
    : 'Die Kernkonfiguration ist gespeichert und die naechsten Schritte liegen jetzt in der Einrichtung.';
  const bannerParts = [title];
  if (payload?.restartRequired) bannerParts.push('Einige Einstellungen werden erst nach einem Dienst-Neustart aktiv.');
  if (warnings.length) bannerParts.push(`Bitte ${warnings.length === 1 ? 'die Warnung' : 'die Warnungen'} unten prüfen.`);
  bannerParts.push('Weiterleitung zum Leitstand...');
  const nextSteps = payload?.restartRequired
    ? ['Im Leitstand prüfen, ob alle Verbindungswerte aktiv sind.', 'Danach den DVhub-Dienst oder die betroffene Verbindung neu starten.']
    : ['Der Leitstand zeigt jetzt die Live-Daten deiner Anlage.'];
  return {
    title,
    kind,
    summary,
    banner: bannerParts.join(' '),
    warnings,
    restartItems,
    nextSteps,
    redirectUrl: '/',
    redirectDelayMs: payload?.restartRequired || warnings.length ? 2600 : 1800
  };
}

const setupWizardHelpers = {
  applyDiscoveredSystemToSetupState,
  buildSetupFieldRenderModel,
  buildSetupSaveOutcome,
  buildSetupSteps,
  collectInheritedDvControlNotes,
  collectInheritedMeterNotes,
  createSetupDiscoveryState,
  createSetupWizardState,
  formatSetupDiscoveredSystemOption,
  getSetupFieldsForStep,
  getSetupFieldDefinitions,
  getSetupStepDefinitions,
  getSetupTransportMode,
  getVisibleSetupFieldsForStep,
  goToNextSetupStep,
  goToPreviousSetupStep,
  resolveWizardValue,
  setActiveSetupStep,
  updateSetupDraftValue,
  validateSetupSubmissionConfig,
  validateSetupWizardState
};

if (typeof globalThis !== 'undefined') {
  globalThis.DVhubSetupWizard = setupWizardHelpers;
}

function setSetupWizardState(nextState) {
  setupDefinition = clone(nextState?.definition || setupDefinition || {});
  setupWizardState = validateSetupWizardState(nextState);
  return setupWizardState;
}

const SETUP_GROUP_ACCENTS = {
  basics: 'cyan',
  transport: 'green',
  dv: 'yellow',
  services: 'blue'
};

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
      (apiFetch ? apiFetch(field.dynamicOptionsUrl) : fetch(field.dynamicOptionsUrl).then(r => r.json())).then(data => {
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
  input.id = getFieldInputId(field.path);
  input.dataset.path = field.path;
  input.dataset.type = field.type;
  return input;
}

function buildMetaText(meta) {
  const parts = [
    `Datei: ${meta.path || '-'}`,
    `Vorhanden: ${meta.exists ? 'Ja' : 'Nein'}`,
    `Gültig: ${meta.valid ? 'Ja' : 'Nein'}`
  ];
  if (meta.parseError) parts.push(`Parse Fehler: ${meta.parseError}`);
  if (Array.isArray(meta.warnings) && meta.warnings.length) parts.push(`Warnungen: ${meta.warnings.length}`);
  return parts.join(' | ');
}

function setBanner(message, kind = 'info') {
  const element = document.getElementById('setupBanner');
  if (!element) return;
  element.textContent = message;
  element.className = `status-banner ${kind}`;
}

function updateMeta() {
  const element = document.getElementById('setupMeta');
  if (!element) return;
  element.textContent = buildMetaText(setupWizardState.meta || {});
}

function getFieldInputId(path) {
  return `setup_field_${path.replace(/[^a-zA-Z0-9]+/g, '_')}`;
}

function parseFieldElementValue(field, element) {
  if (!element) return undefined;
  if (field.type === 'boolean') return element.checked;
  if (field.valueType === 'number') return element.value === '' ? '' : Number(element.value);
  return String(element.value ?? '');
}

function summarizeBlockingErrors(state) {
  return state.validation.summary
    .slice(0, 2)
    .map((entry) => entry.message)
    .join(' ');
}


function renderSetupForm() {
  const grid = document.getElementById('setupGrid');
  if (!grid) return;
  grid.innerHTML = '';

  // Setup only shows the transport step (Victron plant connection)
  // All other settings are in /settings.html
  const SETUP_ONLY_STEPS = ['transport'];

  const steps = getSetupStepDefinitions();
  for (const step of steps) {
    if (!SETUP_ONLY_STEPS.includes(step.id)) continue;
    const fields = getVisibleSetupFieldsForStep(setupWizardState, step.id);
    if (!fields.length) continue;

    const accent = SETUP_GROUP_ACCENTS[step.id] || 'green';
    const group = createConfigGroup(step.title, accent);

    for (const field of fields) {
      const model = buildSetupFieldRenderModel(setupWizardState, field);
      const input = createConfigInput(field, model.value);
      const required = field.setup?.required || false;
      group.appendChild(createConfigRow(field.label, input, { required }));

      // Discovery button — prominent styling
      if (model.discovery.visible) {
        const actions = document.createElement('div');
        actions.style.cssText = 'padding:8px 14px 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-primary';
        btn.style.cssText = 'padding:8px 18px;font-size:13px;font-weight:600;border-radius:8px;';
        btn.dataset.discoveryRun = field.path;
        btn.disabled = model.discovery.loading || !model.discovery.manufacturer;
        btn.textContent = model.discovery.loading ? 'Suche laeuft...' : (model.discovery.actionLabel || 'System suchen');
        actions.appendChild(btn);

        if (model.discovery.systems.length) {
          for (const system of model.discovery.systems) {
            const pickBtn = document.createElement('button');
            pickBtn.type = 'button';
            pickBtn.className = 'btn btn-ghost';
            pickBtn.style.cssText = 'padding:6px 14px;font-size:12px;border:1px solid rgba(76,227,108,0.3);border-radius:6px;';
            pickBtn.dataset.discoveryFieldPath = field.path;
            pickBtn.dataset.discoverySelectSystem = system.id;
            pickBtn.textContent = formatSetupDiscoveredSystemOption(system);
            if (system.id === model.discovery.selectedSystemId) {
              pickBtn.style.borderColor = '#4CE36C';
              pickBtn.style.color = '#4CE36C';
            }
            actions.appendChild(pickBtn);
          }
        }
        group.appendChild(actions);
      }
    }

    grid.appendChild(group);
  }

  // Hint: link to full settings
  const hint = document.createElement('p');
  hint.style.cssText = 'text-align:center;font-size:12px;color:rgba(232,234,240,0.35);margin-top:20px;';
  hint.innerHTML = 'Weitere Einstellungen unter <a href="/settings.html" style="color:var(--flow-green,#4CE36C);text-decoration:none;">Einstellungen</a>';
  grid.appendChild(hint);

  updateSetupSaveBar();
}

function updateSetupSaveBar() {
  const text = document.getElementById('setupSaveBarText');
  if (!text) return;
  const required = getSetupFieldDefinitions().filter(f => f.setup?.required);
  const empty = required.filter(f => {
    const input = document.getElementById(getFieldInputId(f.path));
    if (!input) return true;
    return f.type === 'boolean' ? false : !String(input.value).trim();
  });
  text.textContent = empty.length ? `${empty.length} Pflichtfeld${empty.length === 1 ? '' : 'er'} offen` : 'Bereit';
  document.body.classList.add('has-changes');
}

function renderSetupWizard() {
  renderSetupForm();
  updateMeta();
}

function syncActiveWorkspaceFieldsToDraft() {
  const nextDraft = clone(setupWizardState.draftConfig || {});
  const steps = getSetupStepDefinitions();
  for (const step of steps) {
    for (const field of getVisibleSetupFieldsForStep(setupWizardState, step.id)) {
      const input = document.getElementById(getFieldInputId(field.path));
      if (!input) continue;
      setPath(nextDraft, field.path, parseFieldElementValue(field, input));
    }
  }
  if (hasPath(nextDraft, 'schedule.timezone')) {
    setPath(nextDraft, 'epex.timezone', getPath(nextDraft, 'schedule.timezone'));
  }
  return setSetupWizardState({
    ...setupWizardState,
    draftConfig: nextDraft
  });
}

async function triggerSetupFieldDiscovery(fieldPath) {
  const field = getSetupFieldDefinitions(setupWizardState.definition).find((entry) => entry.path === fieldPath);
  if (!field?.discovery) return;
  const manufacturer = resolveSetupDiscoveryManufacturer(setupWizardState, field);
  if (!manufacturer) {
    setSetupFieldDiscoveryState(fieldPath, createSetupDiscoveryState({
      manufacturer: '',
      error: 'manufacturer required'
    }));
    renderSetupWizard();
    return;
  }

  setSetupFieldDiscoveryState(fieldPath, createSetupDiscoveryState({
    manufacturer,
    loading: true
  }));
  renderSetupWizard();

  try {
    const response = await apiFetch(`/api/discovery/systems?manufacturer=${encodeURIComponent(manufacturer)}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || String(response.status));
    }
    setSetupFieldDiscoveryState(fieldPath, createSetupDiscoveryState({
      manufacturer,
      systems: payload.systems || []
    }));
  } catch (error) {
    setSetupFieldDiscoveryState(fieldPath, createSetupDiscoveryState({
      manufacturer,
      error: error.message || 'Discovery failed'
    }));
  }

  renderSetupWizard();
}

function applySetupFieldDiscoverySelection(fieldPath, selectedSystemId) {
  const discoveryState = getSetupFieldDiscoveryState(fieldPath);
  const selectedSystem = discoveryState.systems.find((system) => system.id === selectedSystemId) || null;
  setSetupWizardState(applyDiscoveredSystemToSetupState({
    state: setupWizardState,
    fieldPath,
    selectedSystem
  }));
  renderSetupWizard();
}

function moveToFirstInvalidStep(state) {
  const firstInvalid = state.stepOrder.find((stepId) => !state.validation.steps[stepId].valid);
  if (!firstInvalid) return state;
  return setSetupWizardState(setActiveSetupStep(state, firstInvalid));
}

function hydrateSetupWizardState(payload) {
  setupDiscoveryStates = {};
  setSetupWizardState(createSetupWizardState({
    definition: payload?.definition || setupDefinition,
    config: payload?.config || {},
    effectiveConfig: payload?.effectiveConfig || {},
    meta: payload?.meta || {},
    activeStepId: setupWizardState.activeStepId
  }));
  renderSetupWizard();
  return setupWizardState;
}

async function saveSetup(config, source = 'setup') {
  const response = await apiFetch(source === 'import' ? '/api/config/import' : '/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config })
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    setBanner(`Setup konnte nicht gespeichert werden: ${payload.error || response.status}`, 'error');
    return false;
  }

  setStoredApiToken(payload.effectiveConfig?.apiToken || '');
  hydrateSetupWizardState({
    config: payload.config,
    effectiveConfig: payload.effectiveConfig,
    meta: payload.meta
  });
  const outcome = buildSetupSaveOutcome(payload, source);
  setSetupWizardState({
    ...setupWizardState,
    lastSaveOutcome: outcome
  });
  renderSetupWizard();
  setBanner(outcome.banner, outcome.kind);
  window.setTimeout(() => {
    window.location.href = outcome.redirectUrl;
  }, outcome.redirectDelayMs);
  return true;
}

async function loadSetup() {
  const response = await apiFetch('/api/config');
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    setBanner(`Setup konnte nicht geladen werden: ${payload.error || response.status}`, 'error');
    return;
  }
  hydrateSetupWizardState(payload);
  if (payload.meta.needsSetup) setBanner('Noch keine gültige Config gefunden. Bitte die Basisdaten eintragen oder eine vorhandene Config importieren.', 'warn');
  else setBanner('Es existiert bereits eine gültige Config. Der Assistent kann trotzdem zum schnellen Ueberschreiben genutzt werden.', 'success');
}

async function importSetupFile(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const submissionState = validateSetupSubmissionConfig(parsed);
    setSetupWizardState(submissionState);
    if (submissionState.validation.isBlocking) {
      moveToFirstInvalidStep(submissionState);
      renderSetupWizard();
      setBanner(`Import enthaelt noch fehlende Pflichtangaben. ${summarizeBlockingErrors(setupWizardState)}`, 'error');
      return;
    }
    await saveSetup(parsed, 'import');
  } catch (error) {
    setBanner(`Import fehlgeschlagen: ${error.message}`, 'error');
  }
}

if (typeof document !== 'undefined') {
  document.getElementById('setupImportLink')?.addEventListener('click', (event) => {
    event.preventDefault();
    document.getElementById('setupImportFile')?.click();
  });

  document.getElementById('setupImportFile')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    await importSetupFile(file);
    event.target.value = '';
  });

  document.getElementById('setupSaveBtn')?.addEventListener('click', () => {
    const syncedState = syncActiveWorkspaceFieldsToDraft();
    const nextState = validateSetupWizardState(syncedState);
    setSetupWizardState(nextState);
    if (nextState.validation.isBlocking) {
      renderSetupWizard();
      setBanner(`Bitte zuerst alle Pflichtangaben korrigieren. ${summarizeBlockingErrors(setupWizardState)}`, 'error');
      return;
    }
    saveSetup(clone(nextState.draftConfig || {})).catch((error) => {
      setBanner(`Setup konnte nicht gespeichert werden: ${error.message}`, 'error');
    });
  });

  document.getElementById('setupGrid')?.addEventListener('change', (event) => {
    const path = event.target?.dataset?.path;
    if (!path) return;
    if (path === 'manufacturer') setupDiscoveryStates = {};
    syncActiveWorkspaceFieldsToDraft();
    if (path === 'victron.transport' || path === 'manufacturer') {
      renderSetupWizard();
      return;
    }
    updateSetupSaveBar();
  });

  document.getElementById('setupGrid')?.addEventListener('input', (event) => {
    const path = event.target?.dataset?.path;
    if (!path) return;
    syncActiveWorkspaceFieldsToDraft();
    updateSetupSaveBar();
  });

  document.getElementById('setupGrid')?.addEventListener('click', (event) => {
    const runButton = event.target.closest('[data-discovery-run]');
    if (runButton) {
      triggerSetupFieldDiscovery(runButton.dataset.discoveryRun).catch((error) => {
        setBanner(`Discovery fehlgeschlagen: ${error.message}`, 'error');
      });
      return;
    }

    const selectionButton = event.target.closest('[data-discovery-select-system]');
    if (!selectionButton) return;
    applySetupFieldDiscoverySelection(
      selectionButton.dataset.discoveryFieldPath,
      selectionButton.dataset.discoverySelectSystem
    );
  });

  window.addEventListener('dvhub:unauthorized', () => {
    setBanner('API-Zugriff abgelehnt. Wenn ein Token aktiv ist, die Seite mit ?token=DEIN_TOKEN öffnen.', 'error');
  });

  loadSetup().catch((error) => setBanner(`Setup konnte nicht geladen werden: ${error.message}`, 'error'));
}
