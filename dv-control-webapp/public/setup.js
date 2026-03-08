const common = typeof window !== 'undefined' ? window.PlexLiteCommon || {} : {};
const { apiFetch, setStoredApiToken } = common;

let setupDefinition = null;

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
  return getSetupStepDefinitions(definitionLike).map((step) => {
    const fields = getSetupFieldsForStep(step.id, definitionLike);
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

function validateIntegerInRange(value, min, max) {
  return Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
}

function validateSetupWizardState(state) {
  const steps = buildSetupSteps(state?.definition || setupDefinition);
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
    definition: clone(state?.definition || setupDefinition || {}),
    steps,
    stepOrder: steps.map((step) => step.id),
    activeStepId: resolveSetupStepId(state?.activeStepId, steps),
    transportMode: transport,
    validation: buildValidationResult(summary, steps)
  };
}

function createSetupWizardState(payload = {}) {
  const definition = clone(payload.definition || setupDefinition || {});
  const steps = buildSetupSteps(definition);
  const initialStepId = resolveSetupStepId(payload.activeStepId, steps);
  const state = {
    definition,
    draftConfig: clone(payload.config || {}),
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

function describeSetupStep(state, stepId = state?.activeStepId) {
  const steps = state?.steps || [];
  const activeStep = steps.find((step) => step.id === stepId) || steps[0] || null;
  const currentIndex = Math.max(0, steps.findIndex((step) => step.id === activeStep?.id));
  const progressCurrent = steps.length ? currentIndex + 1 : 0;
  const visibleFields = activeStep ? getVisibleSetupFieldsForStep(state, activeStep.id) : [];
  const baseDescription = {
    progressLabel: steps.length ? `Schritt ${progressCurrent} von ${steps.length}` : '',
    progressValue: steps.length ? Math.round((progressCurrent / steps.length) * 100) : 0,
    fieldCountLabel: visibleFields.length === 1 ? '1 Fokusfeld' : `${visibleFields.length} Fokusfelder`,
    highlight: {
      eyebrow: activeStep?.label || '',
      title: activeStep?.title || '',
      body: activeStep?.description || ''
    },
    note: ''
  };

  switch (activeStep?.id) {
    case 'basics':
      return {
        ...baseDescription,
        highlight: {
          eyebrow: 'Erster Zugriff',
          title: 'Nur die Daten, die PlexLite direkt erreichbar machen',
          body: 'HTTP-Port und optionales API-Token reichen fuer den ersten sicheren Einstieg.'
        },
        note: 'Alles Weitere bleibt spaeter in den Einstellungen verfuegbar. Hier geht es nur um den schnellen, sicheren Start.'
      };
    case 'transport':
      if (getSetupTransportMode(state) === 'mqtt') {
        return {
          ...baseDescription,
          highlight: {
            eyebrow: 'Venus MQTT',
            title: 'MQTT mit Portal ID und optionalem Broker',
            body: 'Portal ID ist Pflicht. Einen Broker trennst du nur dann ein, wenn PlexLite nicht direkt ueber den GX-Host verbinden soll.'
          },
          note: 'Wenn das Broker-Feld leer bleibt, verwendet PlexLite den GX-Host als MQTT-Fallback. Unpassende Modbus-Felder verschwinden aus diesem Schritt.'
        };
      }
      return {
        ...baseDescription,
        highlight: {
          eyebrow: 'Direkte Registerverbindung',
          title: 'Modbus TCP direkt zum GX',
          body: 'Fuer Modbus brauchst du nur Host, Port, Unit ID und Timeout fuer die erste stabile Registerverbindung.'
        },
        note: 'MQTT-spezifische Felder werden ausgeblendet, damit der Schritt ruhig und eindeutig bleibt.'
      };
    case 'dv':
      return {
        ...baseDescription,
        highlight: {
          eyebrow: 'Proxy & Meter',
          title: 'DV-Port, Meterblock und Vorzeichen an einem Ort',
          body: 'In diesem Schritt definierst du, wie PlexLite Netzwerte liest und spaeter an externe Systeme weiterreicht.'
        },
        note: 'Nur der Kernblock fuer den Start bleibt sichtbar. Host- oder Timeout-Overrides des Meters folgen spaeter in den Einstellungen.'
      };
    case 'services':
      return {
        ...baseDescription,
        highlight: {
          eyebrow: 'Optional zum Start',
          title: 'Zeitzone zuerst, Dienste nur bei Bedarf',
          body: 'Schedule, EPEX und Influx bleiben kompakt. Zusatzfelder erscheinen erst, wenn du den jeweiligen Dienst einschaltest.'
        },
        note: 'So bleibt der letzte Schritt klein, auch wenn du nur die Grundkonfiguration speichern willst.'
      };
    default:
      return baseDescription;
  }
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
  buildSetupSteps,
  createSetupWizardState,
  describeSetupStep,
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
  validateSetupWizardState
};

if (typeof globalThis !== 'undefined') {
  globalThis.PlexLiteSetupWizard = setupWizardHelpers;
}

function setSetupWizardState(nextState) {
  setupDefinition = clone(nextState?.definition || setupDefinition || {});
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
    item.className = 'setup-step-item';
    const button = document.createElement('button');
    const isActive = step.id === setupWizardState.activeStepId;
    const isComplete = setupWizardState.completedStepIds.includes(step.id);
    const isVisited = setupWizardState.visitedStepIds.includes(step.id);
    const currentIndex = getCurrentStepIndex(setupWizardState);
    const stepIndex = setupWizardState.stepOrder.indexOf(step.id);

    button.type = 'button';
    button.dataset.stepId = step.id;
    button.className = 'setup-step-button';
    button.disabled = stepIndex > currentIndex + 1 || (!isVisited && stepIndex > currentIndex);
    button.setAttribute('aria-current', isActive ? 'step' : 'false');
    if (isComplete) button.dataset.state = 'complete';
    else if (isActive) button.dataset.state = 'active';
    else if (isVisited) button.dataset.state = 'visited';

    const index = document.createElement('span');
    index.className = 'setup-step-index';
    index.textContent = String(step.index + 1).padStart(2, '0');

    const copy = document.createElement('span');
    copy.className = 'setup-step-copy';

    const title = document.createElement('strong');
    title.className = 'setup-step-title';
    title.textContent = step.title;

    const summary = document.createElement('small');
    summary.className = 'setup-step-meta';
    if (!setupWizardState.validation.steps[step.id].valid) summary.textContent = 'Pflichtangaben fehlen';
    else if (isComplete) summary.textContent = 'Bereit';
    else if (isActive) summary.textContent = step.description;
    else summary.textContent = `${step.fieldCount} Felder im Fokus`;

    copy.append(title, summary);
    button.append(index, copy);
    item.appendChild(button);
    list.appendChild(item);
  }

  container.appendChild(list);
}

function renderField(field) {
  const wrapper = document.createElement('label');
  wrapper.className = 'settings-field setup-field';
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
  input.dataset.stepId = field.setup?.stepId || '';
  wrapper.appendChild(input);

  const help = document.createElement('small');
  help.className = 'field-help';
  const fieldErrors = setupWizardState.validation.fields[field.path] || [];
  if (fieldErrors.length) wrapper.classList.add('has-error');
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
  const stepDescription = describeSetupStep(setupWizardState, activeStep.id);

  const progress = document.createElement('div');
  progress.className = 'setup-progress';

  const progressHead = document.createElement('div');
  progressHead.className = 'setup-progress-head';

  const progressLabel = document.createElement('p');
  progressLabel.className = 'eyebrow setup-progress-label';
  progressLabel.textContent = stepDescription.progressLabel;

  const progressCount = document.createElement('span');
  progressCount.className = 'setup-progress-count';
  progressCount.textContent = stepDescription.fieldCountLabel;

  const progressBar = document.createElement('div');
  progressBar.className = 'setup-progress-bar';
  const progressFill = document.createElement('span');
  progressFill.className = 'setup-progress-fill';
  progressFill.style.width = `${stepDescription.progressValue}%`;
  progressBar.appendChild(progressFill);

  progressHead.append(progressLabel, progressCount);
  progress.append(progressHead, progressBar);

  const header = document.createElement('div');
  header.className = 'panel-head setup-step-head';

  const titleGroup = document.createElement('div');
  const eyebrow = document.createElement('p');
  eyebrow.className = 'card-title';
  eyebrow.textContent = activeStep.label;
  const title = document.createElement('h2');
  title.className = 'section-title';
  title.textContent = activeStep.title;
  const intro = document.createElement('p');
  intro.className = 'field-help setup-step-intro';
  intro.textContent = activeStep.description;
  titleGroup.append(eyebrow, title, intro);
  header.appendChild(titleGroup);

  const callout = document.createElement('section');
  callout.className = 'setup-callout';

  const calloutEyebrow = document.createElement('p');
  calloutEyebrow.className = 'card-title setup-callout-eyebrow';
  calloutEyebrow.textContent = stepDescription.highlight.eyebrow;

  const calloutTitle = document.createElement('h3');
  calloutTitle.className = 'setup-callout-title';
  calloutTitle.textContent = stepDescription.highlight.title;

  const calloutBody = document.createElement('p');
  calloutBody.className = 'setup-callout-body';
  calloutBody.textContent = stepDescription.highlight.body;

  const calloutNote = document.createElement('p');
  calloutNote.className = 'setup-callout-note';
  calloutNote.textContent = stepDescription.note;

  callout.append(calloutEyebrow, calloutTitle, calloutBody, calloutNote);

  const fields = document.createElement('div');
  fields.className = 'settings-fields compact setup-fields';
  for (const field of getVisibleSetupFieldsForStep(setupWizardState, activeStep.id)) {
    fields.appendChild(renderField(field));
  }

  container.append(progress, header, callout, fields);
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
  const stepDescription = describeSetupStep(setupWizardState);

  const copy = document.createElement('div');
  copy.className = 'setup-nav-copy';

  const copyTitle = document.createElement('strong');
  copyTitle.textContent = isLastStep ? 'Letzter Schritt vor dem Speichern' : 'Weiter zum naechsten Fokusblock';

  const copyBody = document.createElement('span');
  copyBody.textContent = stepDescription.note || 'Jeder Schritt zeigt nur die Felder, die du fuer diesen Abschnitt wirklich brauchst.';

  copy.append(copyTitle, copyBody);

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

  container.append(copy, backButton, nextButton);
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
