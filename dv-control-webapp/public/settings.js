const common = typeof window !== 'undefined' ? window.DVhubCommon || {} : {};
const { apiFetch, buildApiUrl, setStoredApiToken } = common;

const SETTINGS_OVERVIEW_ID = 'overview';

let definition = null;
let currentRawConfig = {};
let currentDraftConfig = {};
let currentEffectiveConfig = {};
let currentMeta = null;
let currentHealth = null;
let settingsShellState = createSettingsShellState();

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
    return [
      {
        id: SETTINGS_OVERVIEW_ID,
        kind: 'overview',
        label: 'Übersicht',
        description: 'Startpunkt für die wichtigsten Einstellungsbereiche.'
      },
      ...sectionsWithFields.map((section) => buildSectionDestination(section, section.fields))
    ];
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

  return [
    {
      id: SETTINGS_OVERVIEW_ID,
      kind: 'overview',
      label: 'Übersicht',
      description: 'Startpunkt für die wichtigsten Einstellungsbereiche.'
    },
    ...sectionDestinations
  ];
}

function resolveActiveSettingsSection(destinations, requestedId) {
  const ids = new Set((destinations || []).map((destination) => destination.id));
  return ids.has(requestedId) ? requestedId : SETTINGS_OVERVIEW_ID;
}

function createSettingsShellState(definitionLike, requestedId = SETTINGS_OVERVIEW_ID) {
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
  SETTINGS_OVERVIEW_ID,
  buildDestinationWorkspace,
  buildSettingsDestinations,
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
  const draftDefined = hasPath(currentDraftConfig, field.path);
  const draftValue = draftDefined ? getPath(currentDraftConfig, field.path) : undefined;
  const effectiveValue = getPath(currentEffectiveConfig, field.path);
  const optionalOverride = field.empty === 'delete';

  if (optionalOverride && !draftDefined) {
    return { value: '', inherited: effectiveValue };
  }
  if (draftValue === null || draftValue === undefined) return { value: '', inherited: effectiveValue };
  return { value: draftValue, inherited: draftDefined ? null : effectiveValue };
}

function renderField(field) {
  const wrapper = document.createElement('label');
  wrapper.className = 'settings-field';
  wrapper.setAttribute('for', fieldId(field.path));

  const title = document.createElement('span');
  title.className = 'settings-field-title';
  title.textContent = field.label;
  wrapper.appendChild(title);

  const { value, inherited } = renderFieldValue(field);
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

function renderSettingsOverview() {
  const overview = document.getElementById('settingsOverview');
  if (!overview) return;

  overview.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'settings-overview-head';
  head.innerHTML = `
    <p class="card-title">Start</p>
    <h2 class="section-title">Womit möchtest du beginnen?</h2>
    <p class="tools-note">Die Übersicht ist der Standard-Einstieg. Von hier aus führt die Seitenleiste in genau einen aktiven Arbeitsbereich.</p>
  `;
  overview.appendChild(head);

  const summary = document.createElement('div');
  summary.className = 'settings-summary';
  for (const destination of settingsShellState.destinations.filter((entry) => entry.kind !== 'overview')) {
    const sectionNames = destination.sections?.map((section) => section.label).join(', ');
    const summaryText = `${buildSectionMeta(destination)}. ${destination.description || 'Konfiguration für diesen Bereich.'}${sectionNames ? ` Enthaelt: ${sectionNames}.` : ''}`;
    summary.appendChild(createSummaryCard(destination.label, summaryText));
  }
  overview.appendChild(summary);
}

function renderSidebarNavigation() {
  const sidebar = document.getElementById('settingsSidebar');
  const navItems = document.getElementById('settingsNavItems');
  if (!sidebar || !navItems) return;

  const overviewButton = sidebar.querySelector('[data-settings-target="overview"]');
  if (overviewButton) {
    const isActive = settingsShellState.activeSectionId === SETTINGS_OVERVIEW_ID;
    overviewButton.classList.toggle('is-active', isActive);
    overviewButton.setAttribute('aria-current', isActive ? 'page' : 'false');
  }

  navItems.innerHTML = '';
  for (const destination of settingsShellState.destinations.filter((entry) => entry.kind !== 'overview')) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-sidebar-item';
    button.dataset.settingsTarget = destination.id;
    const isActive = destination.id === settingsShellState.activeSectionId;
    if (isActive) button.classList.add('is-active');
    button.setAttribute('aria-current', isActive ? 'page' : 'false');
    button.innerHTML = `
      <span class="settings-sidebar-label">${destination.label}</span>
      <small class="settings-sidebar-copy">${destination.description || buildSectionMeta(destination)}</small>
    `;
    navItems.appendChild(button);
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

  const summary = document.createElement('div');
  summary.className = 'settings-workspace-summary';
  summary.appendChild(createSummaryCard('Umfang', buildSectionMeta(destination)));
  summary.appendChild(createSummaryCard('Bereiche', destination.sections.map((section) => section.label).join(', ')));
  summary.appendChild(createSummaryCard('Standard', buildWorkspaceDefaultCopy(destination)));
  panel.appendChild(summary);

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
      const details = document.createElement('details');
      details.className = 'settings-group';
      details.open = group.openByDefault;

      const summary = document.createElement('summary');
      summary.innerHTML = `<span>${group.label}</span><small>${group.description || ''}</small>`;
      details.appendChild(summary);

      const grid = document.createElement('div');
      grid.className = 'settings-fields';
      for (const field of group.fields) grid.appendChild(renderField(field));
      details.appendChild(grid);
      groupList.appendChild(details);
    }

    sectionShell.appendChild(groupList);
    panel.appendChild(sectionShell);
  }

  mount.appendChild(panel);
}

function renderActiveSettingsDestination() {
  const overview = document.getElementById('settingsOverview');
  const workspace = document.getElementById('settingsWorkspace');
  const activeDestination = getActiveSettingsDestination();
  if (!overview || !workspace) return;

  if (!activeDestination || activeDestination.id === SETTINGS_OVERVIEW_ID) {
    renderSettingsOverview();
    overview.hidden = false;
    workspace.hidden = true;
    const mount = document.getElementById('settingsSections');
    if (mount) mount.innerHTML = '';
    return;
  }

  overview.hidden = true;
  workspace.hidden = false;
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
  return clone(currentDraftConfig || {});
}

function applyConfigPayload(payload) {
  definition = payload.definition || definition;
  currentRawConfig = payload.config || {};
  currentDraftConfig = clone(currentRawConfig);
  currentEffectiveConfig = payload.effectiveConfig || {};
  currentMeta = payload.meta || {};
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
  document.getElementById('serviceMeta').textContent =
    `Service: ${service.name || '-'} | Status: ${service.status || '-'} | Runtime: ${payload.runtime?.node || '-'} | Geprueft: ${fmtTs(payload.checkedAt)}`;

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
  await loadHealth();
  return true;
}

async function saveCurrentForm() {
  const config = collectConfigFromForm();
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
  document.getElementById('settingsSidebar')?.addEventListener('click', (event) => {
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
  loadHealth().catch((error) => {
    setHealthBanner(`Health-Status konnte nicht geladen werden: ${error.message}`, 'error');
  });
}

if (typeof document !== 'undefined') {
  initSettingsPage();
}
