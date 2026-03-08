const { apiFetch, buildApiUrl, setStoredApiToken } = window.PlexLiteCommon;

let definition = null;
let currentRawConfig = {};
let currentEffectiveConfig = {};
let currentMeta = null;
let currentHealth = null;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
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
    `Gueltig: ${meta.valid ? 'Ja' : 'Nein'}`
  ];
  if (meta.parseError) parts.push(`Parse Fehler: ${meta.parseError}`);
  if (Array.isArray(meta.warnings) && meta.warnings.length) parts.push(`Warnungen: ${meta.warnings.length}`);
  parts.push(`Zuletzt geladen: ${fmtTs(Date.now())}`);
  return parts.join(' | ');
}

function renderFieldValue(field) {
  const rawDefined = hasPath(currentRawConfig, field.path);
  const rawValue = rawDefined ? getPath(currentRawConfig, field.path) : undefined;
  const effectiveValue = getPath(currentEffectiveConfig, field.path);
  const optionalOverride = field.empty === 'delete';

  if (optionalOverride && !rawDefined) {
    return { value: '', inherited: effectiveValue };
  }
  if (rawValue === null || rawValue === undefined) return { value: '', inherited: effectiveValue };
  return { value: rawValue, inherited: rawDefined ? null : effectiveValue };
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

function renderDefinition() {
  const mount = document.getElementById('settingsSections');
  mount.innerHTML = '';

  for (const section of definition.sections || []) {
    const sectionFields = (definition.fields || []).filter((field) => field.section === section.id);
    if (!sectionFields.length) continue;

    const panel = document.createElement('section');
    panel.className = 'panel reveal settings-panel';

    const header = document.createElement('div');
    header.className = 'panel-head';
    header.innerHTML = `
      <div>
        <p class="card-title">${section.label}</p>
        <h2 class="section-title">${section.label}</h2>
      </div>
    `;
    panel.appendChild(header);

    const intro = document.createElement('p');
    intro.className = 'tools-note';
    intro.textContent = section.description || '';
    panel.appendChild(intro);

    for (const group of groupFields(sectionFields)) {
      const details = document.createElement('details');
      details.className = 'settings-group';
      details.open = true;

      const summary = document.createElement('summary');
      summary.innerHTML = `<span>${group.label}</span><small>${group.description || ''}</small>`;
      details.appendChild(summary);

      const grid = document.createElement('div');
      grid.className = 'settings-fields';
      for (const field of group.fields) grid.appendChild(renderField(field));
      details.appendChild(grid);
      panel.appendChild(details);
    }

    mount.appendChild(panel);
  }
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
  const next = clone(currentRawConfig || {});
  for (const field of definition.fields || []) {
    const parsed = parseFieldInput(field);
    if (parsed && parsed.action === 'delete') deletePath(next, field.path);
    else setPath(next, field.path, parsed);
  }
  return next;
}

function applyConfigPayload(payload) {
  definition = payload.definition || definition;
  currentRawConfig = payload.config || {};
  currentEffectiveConfig = payload.effectiveConfig || {};
  currentMeta = payload.meta || {};
  setStoredApiToken(currentEffectiveConfig.apiToken || '');
  document.getElementById('configMeta').textContent = buildMetaText(currentMeta);
  renderDefinition();
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

  if (!service.enabled) setHealthBanner('Restart-Aktionen sind deaktiviert. Aktivierung erfolgt ueber den Installer bzw. ENV-Variablen.', 'warn');
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
  if (currentMeta.needsSetup) setBanner('Es wurde noch keine gueltige Config gefunden. Du kannst sie hier direkt anlegen oder den Setup-Assistenten nutzen.', 'warn');
  else setBanner('Konfiguration geladen. Aenderungen koennen jetzt im Menue bearbeitet werden.', 'success');
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
    ? ` Neustart empfohlen fuer: ${payload.restartRequiredPaths.join(', ')}`
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

window.addEventListener('plexlite:unauthorized', () => {
  setBanner('API-Zugriff abgelehnt. Falls ein API-Token gesetzt ist, die Seite mit ?token=DEIN_TOKEN oeffnen oder das Token neu speichern.', 'error');
});

loadConfig().catch((error) => {
  setBanner(`Konfiguration konnte nicht geladen werden: ${error.message}`, 'error');
});
loadHealth().catch((error) => {
  setHealthBanner(`Health-Status konnte nicht geladen werden: ${error.message}`, 'error');
});
