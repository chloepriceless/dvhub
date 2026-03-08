const common = typeof window !== 'undefined' ? window.PlexLiteCommon || {} : {};
const { apiFetch, setStoredApiToken } = common;

const SETUP_STEP_DEFINITIONS = [
  {
    id: 'basics',
    index: 0,
    label: 'Schritt 1',
    title: 'Webserver & Sicherheit',
    description: 'Grundlegende Einstellungen fuer Webzugriff und API-Schutz.'
  },
  {
    id: 'transport',
    index: 1,
    label: 'Schritt 2',
    title: 'Victron Verbindung',
    description: 'Transport, GX-Verbindung und MQTT-Basisdaten.'
  },
  {
    id: 'dv',
    index: 2,
    label: 'Schritt 3',
    title: 'DV & Meter',
    description: 'Proxy-Port, Meterblock und Vorzeichenlogik fuer Netzwerte.'
  },
  {
    id: 'services',
    index: 3,
    label: 'Schritt 4',
    title: 'Preise & Zusatzdienste',
    description: 'Zeitzone sowie optionale Preis- und Logging-Dienste.'
  }
];

const SETUP_FIELD_DEFINITIONS = [
  {
    stepId: 'basics',
    path: 'httpPort',
    label: 'HTTP Port',
    help: 'Port der Weboberflaeche. Standard ist 8080.',
    type: 'number',
    valueType: 'number',
    min: 1,
    max: 65535
  },
  {
    stepId: 'basics',
    path: 'apiToken',
    label: 'API Token',
    help: 'Optional. Wenn gesetzt, wird es nach dem Speichern fuer diese Browser-Session hinterlegt.',
    type: 'text',
    valueType: 'string'
  },
  {
    stepId: 'transport',
    path: 'victron.transport',
    label: 'Transport',
    help: 'Modbus ist der Standard fuer GX und Ekrano. MQTT ist fuer Venus OS Push-Daten.',
    type: 'select',
    valueType: 'string',
    options: [
      { value: 'modbus', label: 'Modbus TCP' },
      { value: 'mqtt', label: 'MQTT' }
    ]
  },
  {
    stepId: 'transport',
    path: 'victron.host',
    label: 'GX Host',
    help: 'IP-Adresse oder DNS-Name des GX.',
    type: 'text',
    valueType: 'string'
  },
  {
    stepId: 'transport',
    path: 'victron.port',
    label: 'GX Port',
    help: 'Standard fuer Modbus TCP ist 502.',
    type: 'number',
    valueType: 'number',
    min: 1,
    max: 65535
  },
  {
    stepId: 'transport',
    path: 'victron.unitId',
    label: 'Unit ID',
    help: 'Typischerweise 100 beim Victron GX.',
    type: 'number',
    valueType: 'number',
    min: 0,
    max: 255
  },
  {
    stepId: 'transport',
    path: 'victron.timeoutMs',
    label: 'Timeout (ms)',
    help: 'Timeout fuer Register-Requests.',
    type: 'number',
    valueType: 'number',
    min: 100,
    max: 60000
  },
  {
    stepId: 'transport',
    path: 'victron.mqtt.broker',
    label: 'MQTT Broker URL',
    help: 'Zum Beispiel mqtt://192.168.1.10:1883.',
    type: 'text',
    valueType: 'string',
    visibleWhen(state) {
      return getSetupTransportMode(state) === 'mqtt';
    }
  },
  {
    stepId: 'transport',
    path: 'victron.mqtt.portalId',
    label: 'Portal ID',
    help: 'Victron Portal ID fuer die MQTT Topics.',
    type: 'text',
    valueType: 'string',
    visibleWhen(state) {
      return getSetupTransportMode(state) === 'mqtt';
    }
  },
  {
    stepId: 'transport',
    path: 'victron.mqtt.keepaliveIntervalMs',
    label: 'Keepalive (ms)',
    help: 'Intervall fuer MQTT Keepalive-Pakete.',
    type: 'number',
    valueType: 'number',
    min: 1000,
    max: 600000,
    visibleWhen(state) {
      return getSetupTransportMode(state) === 'mqtt';
    }
  },
  {
    stepId: 'dv',
    path: 'modbusListenHost',
    label: 'Modbus Listen Host',
    help: 'Normalerweise 0.0.0.0 fuer alle Interfaces.',
    type: 'text',
    valueType: 'string'
  },
  {
    stepId: 'dv',
    path: 'modbusListenPort',
    label: 'Modbus Listen Port',
    help: 'LUOX / Direktvermarkter verbinden sich spaeter auf diesen Proxy-Port.',
    type: 'number',
    valueType: 'number',
    min: 1,
    max: 65535
  },
  {
    stepId: 'dv',
    path: 'gridPositiveMeans',
    label: 'Grid Vorzeichen',
    help: 'Abhaengig davon, wie dein Meter die Phasenleistung meldet.',
    type: 'select',
    valueType: 'string',
    options: [
      { value: 'feed_in', label: 'Positiv bedeutet Einspeisung' },
      { value: 'grid_import', label: 'Positiv bedeutet Netzbezug' }
    ]
  },
  {
    stepId: 'dv',
    path: 'meter.fc',
    label: 'Meter FC',
    help: 'Typischerweise 4 fuer Victron Meterbloecke.',
    type: 'select',
    valueType: 'number',
    options: [
      { value: 4, label: '4 - Input Register' },
      { value: 3, label: '3 - Holding Register' }
    ]
  },
  {
    stepId: 'dv',
    path: 'meter.address',
    label: 'Meter Startadresse',
    help: 'Standardblock fuer Grid L1/L2/L3 ist 820.',
    type: 'number',
    valueType: 'number',
    min: 0,
    max: 65535
  },
  {
    stepId: 'dv',
    path: 'meter.quantity',
    label: 'Meter Registeranzahl',
    help: 'Standard ist 3 Register fuer L1/L2/L3.',
    type: 'number',
    valueType: 'number',
    min: 1,
    max: 125
  },
  {
    stepId: 'dv',
    path: 'dvControl.enabled',
    label: 'DV Control aktivieren',
    help: 'Schreibt bei DV-Signalen automatisch in die Victron Register 2848 und 2850.',
    type: 'boolean',
    valueType: 'boolean'
  },
  {
    stepId: 'services',
    path: 'schedule.timezone',
    label: 'Zeitzone',
    help: 'Wird fuer Schedule und Darstellung genutzt. Standard ist Europe/Berlin.',
    type: 'text',
    valueType: 'string'
  },
  {
    stepId: 'services',
    path: 'epex.enabled',
    label: 'EPEX aktiv',
    help: 'Aktiviert Day-Ahead-Preise und Negativpreis-Schutz.',
    type: 'boolean',
    valueType: 'boolean'
  },
  {
    stepId: 'services',
    path: 'epex.bzn',
    label: 'BZN',
    help: 'Beispiel: DE-LU.',
    type: 'text',
    valueType: 'string'
  },
  {
    stepId: 'services',
    path: 'influx.enabled',
    label: 'Influx aktiv',
    help: 'Optional fuer Langzeit-Logging.',
    type: 'boolean',
    valueType: 'boolean'
  },
  {
    stepId: 'services',
    path: 'influx.url',
    label: 'Influx URL',
    help: 'Zum Beispiel http://127.0.0.1:8086.',
    type: 'text',
    valueType: 'string'
  },
  {
    stepId: 'services',
    path: 'influx.db',
    label: 'Influx DB',
    help: 'Datenbankname fuer Influx.',
    type: 'text',
    valueType: 'string'
  }
];

let setupWizardState = createSetupWizardState();

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

function resolveSetupStepId(stepId) {
  const validIds = new Set(SETUP_STEP_DEFINITIONS.map((step) => step.id));
  return validIds.has(stepId) ? stepId : SETUP_STEP_DEFINITIONS[0].id;
}

function getSetupFieldsForStep(stepId) {
  return SETUP_FIELD_DEFINITIONS.filter((field) => field.stepId === stepId);
}

function getVisibleSetupFieldsForStep(state, stepId) {
  return getSetupFieldsForStep(stepId).filter((field) => (typeof field.visibleWhen === 'function' ? field.visibleWhen(state) : true));
}

function buildSetupSteps() {
  return SETUP_STEP_DEFINITIONS.map((step) => {
    const fields = getSetupFieldsForStep(step.id);
    return {
      ...step,
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

function getSetupTransportMode(state) {
  return resolveWizardValue(state, 'victron.transport', 'modbus') === 'mqtt' ? 'mqtt' : 'modbus';
}

function buildValidationResult(summary) {
  const fields = {};
  const steps = {};
  for (const step of SETUP_STEP_DEFINITIONS) {
    steps[step.id] = { valid: true, errors: [] };
  }
  for (const entry of summary) {
    steps[entry.stepId].valid = false;
    steps[entry.stepId].errors.push(entry.message);
    if (!fields[entry.path]) fields[entry.path] = [];
    fields[entry.path].push(entry.message);
  }
  return {
    fields,
    steps,
    summary,
    isBlocking: summary.length > 0
  };
}

function pushValidationError(summary, stepId, path, message) {
  summary.push({ stepId, path, message });
}

function validateIntegerInRange(value, min, max) {
  return Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
}

function validateSetupWizardState(state) {
  const summary = [];
  const transport = getSetupTransportMode(state);
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

  requireInteger('basics', 'httpPort', 1, 65535, 'Bitte einen gueltigen Port zwischen 1 und 65535 eingeben.');

  requireOption('transport', 'victron.transport', ['modbus', 'mqtt'], 'Bitte einen gueltigen Victron-Transport waehlen.');
  requireText('transport', 'victron.host', 'Bitte den GX-Host oder DNS-Namen angeben.');
  if (transport === 'modbus') {
    requireInteger('transport', 'victron.port', 1, 65535, 'Bitte einen gueltigen GX-Port zwischen 1 und 65535 eingeben.');
    requireInteger('transport', 'victron.unitId', 0, 255, 'Bitte eine gueltige Unit ID zwischen 0 und 255 eingeben.');
    requireInteger('transport', 'victron.timeoutMs', 100, 60000, 'Bitte einen gueltigen Timeout zwischen 100 und 60000 ms eingeben.');
  } else {
    requireText('transport', 'victron.mqtt.portalId', 'Bitte die Victron Portal ID fuer MQTT angeben.');
    requireInteger('transport', 'victron.mqtt.keepaliveIntervalMs', 1000, 600000, 'Bitte ein gueltiges Keepalive zwischen 1000 und 600000 ms eingeben.');
  }

  requireText('dv', 'modbusListenHost', 'Bitte den Modbus-Listen-Host angeben.');
  requireInteger('dv', 'modbusListenPort', 1, 65535, 'Bitte einen gueltigen Port zwischen 1 und 65535 eingeben.');
  requireOption('dv', 'gridPositiveMeans', ['feed_in', 'grid_import'], 'Bitte eine gueltige Vorzeichenlogik waehlen.');
  requireOption('dv', 'meter.fc', [3, 4], 'Bitte einen gueltigen Meter Function Code waehlen.');
  requireInteger('dv', 'meter.address', 0, 65535, 'Bitte eine gueltige Meter-Startadresse zwischen 0 und 65535 eingeben.');
  requireInteger('dv', 'meter.quantity', 1, 125, 'Bitte eine gueltige Registeranzahl zwischen 1 und 125 eingeben.');

  requireText('services', 'schedule.timezone', 'Bitte eine Zeitzone fuer den Zeitplan angeben.');
  if (resolveWizardValue(state, 'epex.enabled', false)) {
    requireText('services', 'epex.bzn', 'Bitte die BZN fuer den EPEX-Dienst angeben.');
  }
  if (resolveWizardValue(state, 'influx.enabled', false)) {
    requireText('services', 'influx.url', 'Bitte die Influx-URL angeben.');
    requireText('services', 'influx.db', 'Bitte die Influx-Datenbank angeben.');
  }

  return {
    ...state,
    transportMode: transport,
    validation: buildValidationResult(summary)
  };
}

function createSetupWizardState(payload = {}) {
  const steps = buildSetupSteps();
  const initialStepId = resolveSetupStepId(payload.activeStepId);
  const state = {
    draftConfig: clone(payload.config || {}),
    effectiveConfig: clone(payload.effectiveConfig || {}),
    meta: clone(payload.meta || {}),
    steps,
    stepOrder: steps.map((step) => step.id),
    activeStepId: initialStepId,
    visitedStepIds: Array.from(new Set([initialStepId])),
    completedStepIds: [],
    transportMode: 'modbus',
    validation: buildValidationResult([])
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

function setActiveSetupStep(state, requestedStepId) {
  const activeStepId = resolveSetupStepId(requestedStepId);
  return {
    ...state,
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

const setupWizardHelpers = {
  SETUP_FIELD_DEFINITIONS,
  SETUP_STEP_DEFINITIONS,
  createSetupWizardState,
  getSetupFieldsForStep,
  getSetupTransportMode,
  goToNextSetupStep,
  goToPreviousSetupStep,
  resolveWizardValue,
  setActiveSetupStep,
  updateSetupDraftValue,
  validateSetupWizardState
};

if (typeof globalThis !== 'undefined') {
  globalThis.PlexLiteSetupWizard = setupWizardHelpers;
}

function setSetupWizardState(nextState) {
  setupWizardState = validateSetupWizardState(nextState);
  return setupWizardState;
}

function buildMetaText(meta) {
  const parts = [
    `Datei: ${meta.path || '-'}`,
    `Vorhanden: ${meta.exists ? 'Ja' : 'Nein'}`,
    `Gueltig: ${meta.valid ? 'Ja' : 'Nein'}`
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

function renderSetupSteps() {
  const container = document.getElementById('setup-steps');
  if (!container) return;
  container.replaceChildren();

  const list = document.createElement('ol');
  list.className = 'wizard-steps';

  for (const step of setupWizardState.steps) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    const isActive = step.id === setupWizardState.activeStepId;
    const isComplete = setupWizardState.completedStepIds.includes(step.id);
    const isVisited = setupWizardState.visitedStepIds.includes(step.id);
    const currentIndex = getCurrentStepIndex(setupWizardState);
    const stepIndex = setupWizardState.stepOrder.indexOf(step.id);

    button.type = 'button';
    button.dataset.stepId = step.id;
    button.className = 'btn btn-ghost';
    button.disabled = stepIndex > currentIndex + 1 || (!isVisited && stepIndex > currentIndex);
    button.textContent = `${step.label}: ${step.title}`;
    button.setAttribute('aria-current', isActive ? 'step' : 'false');
    if (isComplete) button.dataset.state = 'complete';
    else if (isActive) button.dataset.state = 'active';
    else if (isVisited) button.dataset.state = 'visited';

    const meta = document.createElement('small');
    meta.className = 'field-help';
    if (!setupWizardState.validation.steps[step.id].valid) meta.textContent = 'Pflichtangaben fehlen';
    else if (isComplete) meta.textContent = 'Bereit';
    else if (isActive) meta.textContent = step.description;
    else meta.textContent = 'Noch offen';

    item.append(button, meta);
    list.appendChild(item);
  }

  container.appendChild(list);
}

function renderField(field) {
  const wrapper = document.createElement('label');
  wrapper.className = 'settings-field';
  if (field.type === 'boolean') wrapper.classList.add('checkbox-field');

  const title = document.createElement('span');
  title.className = 'settings-field-title';
  title.textContent = field.label;
  wrapper.appendChild(title);

  let input;
  const value = resolveWizardValue(setupWizardState, field.path, field.type === 'boolean' ? false : '');
  if (field.type === 'boolean') {
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
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
    input.value = value === null || value === undefined ? '' : String(value);
  }

  input.id = getFieldInputId(field.path);
  input.dataset.path = field.path;
  input.dataset.stepId = field.stepId;
  wrapper.appendChild(input);

  const help = document.createElement('small');
  help.className = 'field-help';
  const fieldErrors = setupWizardState.validation.fields[field.path] || [];
  help.textContent = fieldErrors.length ? fieldErrors[0] : field.help || '';
  wrapper.appendChild(help);

  return wrapper;
}

function renderSetupWorkspace() {
  const container = document.getElementById('setup-workspace');
  if (!container) return;
  container.replaceChildren();

  const activeStep = setupWizardState.steps.find((step) => step.id === setupWizardState.activeStepId);
  if (!activeStep) return;

  const header = document.createElement('div');
  header.className = 'panel-head';

  const titleGroup = document.createElement('div');
  const eyebrow = document.createElement('p');
  eyebrow.className = 'card-title';
  eyebrow.textContent = activeStep.label;
  const title = document.createElement('h2');
  title.className = 'section-title';
  title.textContent = activeStep.title;
  const intro = document.createElement('p');
  intro.className = 'field-help';
  intro.textContent = activeStep.description;
  titleGroup.append(eyebrow, title, intro);
  header.appendChild(titleGroup);

  const fields = document.createElement('div');
  fields.className = 'settings-fields compact';
  for (const field of getVisibleSetupFieldsForStep(setupWizardState, activeStep.id)) {
    fields.appendChild(renderField(field));
  }

  container.append(header, fields);
}

function renderSetupErrors() {
  const container = document.getElementById('setup-errors');
  if (!container) return;
  container.replaceChildren();
  container.className = 'status-banner';

  const stepErrors = setupWizardState.validation.summary.filter((entry) => entry.stepId === setupWizardState.activeStepId);
  if (!stepErrors.length) {
    container.classList.add('info');
    container.textContent = 'Dieser Schritt ist bereit. Mit Weiter gehst du zur naechsten Setup-Seite.';
    return;
  }

  container.classList.add('error');
  const list = document.createElement('ul');
  for (const entry of stepErrors) {
    const item = document.createElement('li');
    item.textContent = entry.message;
    list.appendChild(item);
  }
  container.appendChild(list);
}

function renderSetupNav() {
  const container = document.getElementById('setup-nav');
  if (!container) return;
  container.replaceChildren();

  const currentIndex = getCurrentStepIndex(setupWizardState);
  const isLastStep = currentIndex === setupWizardState.stepOrder.length - 1;

  const backButton = document.createElement('button');
  backButton.type = 'button';
  backButton.className = 'btn btn-ghost';
  backButton.dataset.action = 'back';
  backButton.disabled = currentIndex === 0;
  backButton.textContent = 'Zurueck';

  const nextButton = document.createElement('button');
  nextButton.type = 'button';
  nextButton.className = 'btn btn-primary';
  nextButton.dataset.action = 'next';
  nextButton.textContent = isLastStep ? 'Schritt pruefen' : 'Weiter';

  container.append(backButton, nextButton);
}

function renderSetupWizard() {
  renderSetupSteps();
  renderSetupWorkspace();
  renderSetupErrors();
  renderSetupNav();
  updateMeta();
}

function syncActiveWorkspaceFieldsToDraft() {
  const nextDraft = clone(setupWizardState.draftConfig || {});
  for (const field of getVisibleSetupFieldsForStep(setupWizardState, setupWizardState.activeStepId)) {
    const input = document.getElementById(getFieldInputId(field.path));
    if (!input) continue;
    setPath(nextDraft, field.path, parseFieldElementValue(field, input));
  }
  if (hasPath(nextDraft, 'schedule.timezone')) {
    setPath(nextDraft, 'epex.timezone', getPath(nextDraft, 'schedule.timezone'));
  }
  return setSetupWizardState({
    ...setupWizardState,
    draftConfig: nextDraft
  });
}

function moveToFirstInvalidStep(state) {
  const firstInvalid = state.stepOrder.find((stepId) => !state.validation.steps[stepId].valid);
  if (!firstInvalid) return state;
  return setSetupWizardState(setActiveSetupStep(state, firstInvalid));
}

function hydrateSetupWizardState(payload) {
  setSetupWizardState(createSetupWizardState({
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
  const restartNote = payload.restartRequired ? ' Einige Einstellungen werden erst nach einem Dienst-Neustart aktiv.' : '';
  setBanner(`Setup gespeichert.${restartNote} Weiterleitung zu den Einstellungen...`, payload.restartRequired ? 'warn' : 'success');
  window.setTimeout(() => {
    window.location.href = '/settings.html?setup=done';
  }, 1200);
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
  if (payload.meta.needsSetup) setBanner('Noch keine gueltige Config gefunden. Bitte die Basisdaten eintragen oder eine vorhandene Config importieren.', 'warn');
  else setBanner('Es existiert bereits eine gueltige Config. Der Assistent kann trotzdem zum schnellen Ueberschreiben genutzt werden.', 'success');
}

async function importSetupFile(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    await saveSetup(parsed, 'import');
  } catch (error) {
    setBanner(`Import fehlgeschlagen: ${error.message}`, 'error');
  }
}

function handleWizardStepNavigation(requestedStepId) {
  const currentIndex = getCurrentStepIndex(setupWizardState);
  const requestedIndex = setupWizardState.stepOrder.indexOf(requestedStepId);
  syncActiveWorkspaceFieldsToDraft();

  if (requestedIndex > currentIndex) {
    const nextState = goToNextSetupStep(setupWizardState);
    setSetupWizardState(nextState);
    if (nextState.activeStepId !== requestedStepId && nextState.activeStepId === setupWizardState.activeStepId) {
      moveToFirstInvalidStep(nextState);
      renderSetupWizard();
      setBanner(`Bitte zuerst die Pflichtangaben im aktuellen Schritt korrigieren. ${summarizeBlockingErrors(setupWizardState)}`, 'error');
      return;
    }
  } else {
    setSetupWizardState(setActiveSetupStep(setupWizardState, requestedStepId));
  }

  renderSetupWizard();
}

function handleWizardNav(action) {
  const syncedState = syncActiveWorkspaceFieldsToDraft();
  if (action === 'back') {
    setSetupWizardState(goToPreviousSetupStep(syncedState));
    renderSetupWizard();
    return;
  }

  const nextState = goToNextSetupStep(syncedState);
  setSetupWizardState(nextState);
  if (nextState.activeStepId === syncedState.activeStepId) {
    renderSetupWizard();
    setBanner(`Bitte zuerst die Pflichtangaben im aktuellen Schritt korrigieren. ${summarizeBlockingErrors(nextState)}`, 'error');
    return;
  }

  renderSetupWizard();
  setBanner('Schritt gespeichert. Du kannst weiter zur naechsten Setup-Seite gehen.', 'info');
}

function collectConfig() {
  const syncedState = syncActiveWorkspaceFieldsToDraft();
  return clone(syncedState.draftConfig || {});
}

if (typeof document !== 'undefined') {
  document.getElementById('setupSaveBtn')?.addEventListener('click', () => {
    const nextState = validateSetupWizardState(syncActiveWorkspaceFieldsToDraft());
    setSetupWizardState(nextState);
    if (nextState.validation.isBlocking) {
      moveToFirstInvalidStep(nextState);
      renderSetupWizard();
      setBanner(`Bitte zuerst alle Pflichtangaben korrigieren. ${summarizeBlockingErrors(setupWizardState)}`, 'error');
      return;
    }

    saveSetup(collectConfig()).catch((error) => {
      setBanner(`Setup konnte nicht gespeichert werden: ${error.message}`, 'error');
    });
  });

  document.getElementById('setupImportBtn')?.addEventListener('click', () => {
    document.getElementById('setupImportFile')?.click();
  });

  document.getElementById('setupImportFile')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    await importSetupFile(file);
    event.target.value = '';
  });

  document.getElementById('setup-workspace')?.addEventListener('input', (event) => {
    const path = event.target?.dataset?.path;
    if (!path) return;
    syncActiveWorkspaceFieldsToDraft();
    renderSetupErrors();
    renderSetupSteps();
  });

  document.getElementById('setup-workspace')?.addEventListener('change', (event) => {
    const path = event.target?.dataset?.path;
    if (!path) return;
    syncActiveWorkspaceFieldsToDraft();
    if (path === 'victron.transport') {
      renderSetupWizard();
      return;
    }
    renderSetupErrors();
    renderSetupSteps();
  });

  document.getElementById('setup-steps')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-step-id]');
    if (!button || button.disabled) return;
    handleWizardStepNavigation(button.dataset.stepId);
  });

  document.getElementById('setup-nav')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    handleWizardNav(button.dataset.action);
  });

  window.addEventListener('plexlite:unauthorized', () => {
    setBanner('API-Zugriff abgelehnt. Wenn ein Token aktiv ist, die Seite mit ?token=DEIN_TOKEN oeffnen.', 'error');
  });

  loadSetup().catch((error) => setBanner(`Setup konnte nicht geladen werden: ${error.message}`, 'error'));
}
