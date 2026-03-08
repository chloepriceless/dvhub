const { apiFetch, setStoredApiToken } = window.PlexLiteCommon;

let currentConfig = {};
let currentEffectiveConfig = {};
let currentMeta = {};

function setBanner(message, kind = 'info') {
  const el = document.getElementById('setupBanner');
  if (!el) return;
  el.textContent = message;
  el.className = `status-banner ${kind}`;
}

function setValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.type === 'checkbox') el.checked = Boolean(value);
  else el.value = value ?? '';
}

function getValue(id) {
  const el = document.getElementById(id);
  if (!el) return '';
  if (el.type === 'checkbox') return el.checked;
  return el.value;
}

function updateMeta() {
  const parts = [
    `Datei: ${currentMeta.path || '-'}`,
    `Vorhanden: ${currentMeta.exists ? 'Ja' : 'Nein'}`,
    `Gueltig: ${currentMeta.valid ? 'Ja' : 'Nein'}`
  ];
  if (currentMeta.parseError) parts.push(`Parse Fehler: ${currentMeta.parseError}`);
  document.getElementById('setupMeta').textContent = parts.join(' | ');
}

function updateTransportVisibility() {
  const transport = getValue('victronTransport');
  const mqttFields = document.getElementById('mqttFields');
  if (mqttFields) mqttFields.style.display = transport === 'mqtt' ? 'grid' : 'none';
}

function applyConfigToForm(config, meta) {
  currentConfig = config || {};
  currentEffectiveConfig = meta.effectiveConfig || {};
  currentMeta = meta.meta || {};

  setValue('httpPort', currentEffectiveConfig.httpPort);
  setValue('apiToken', currentEffectiveConfig.apiToken);
  setValue('victronTransport', currentEffectiveConfig.victron?.transport || 'modbus');
  setValue('victronHost', currentEffectiveConfig.victron?.host);
  setValue('victronPort', currentEffectiveConfig.victron?.port);
  setValue('victronUnitId', currentEffectiveConfig.victron?.unitId);
  setValue('victronTimeoutMs', currentEffectiveConfig.victron?.timeoutMs);
  setValue('mqttBroker', currentEffectiveConfig.victron?.mqtt?.broker);
  setValue('mqttPortalId', currentEffectiveConfig.victron?.mqtt?.portalId);
  setValue('mqttKeepalive', currentEffectiveConfig.victron?.mqtt?.keepaliveIntervalMs);
  setValue('modbusListenHost', currentEffectiveConfig.modbusListenHost);
  setValue('modbusListenPort', currentEffectiveConfig.modbusListenPort);
  setValue('gridPositiveMeans', currentEffectiveConfig.gridPositiveMeans);
  setValue('meterFc', currentEffectiveConfig.meter?.fc);
  setValue('meterAddress', currentEffectiveConfig.meter?.address);
  setValue('meterQuantity', currentEffectiveConfig.meter?.quantity);
  setValue('dvControlEnabled', currentEffectiveConfig.dvControl?.enabled);
  setValue('scheduleTimezone', currentEffectiveConfig.schedule?.timezone);
  setValue('epexEnabled', currentEffectiveConfig.epex?.enabled);
  setValue('epexBzn', currentEffectiveConfig.epex?.bzn);
  setValue('influxEnabled', currentEffectiveConfig.influx?.enabled);
  setValue('influxUrl', currentEffectiveConfig.influx?.url);
  setValue('influxDb', currentEffectiveConfig.influx?.db);

  updateTransportVisibility();
  updateMeta();
}

function collectConfig() {
  const next = JSON.parse(JSON.stringify(currentConfig || {}));
  next.httpPort = Number(getValue('httpPort'));
  next.apiToken = String(getValue('apiToken') || '');
  next.modbusListenHost = String(getValue('modbusListenHost') || '0.0.0.0');
  next.modbusListenPort = Number(getValue('modbusListenPort'));
  next.gridPositiveMeans = String(getValue('gridPositiveMeans') || 'feed_in');
  next.schedule = next.schedule || {};
  next.schedule.timezone = String(getValue('scheduleTimezone') || 'Europe/Berlin');

  next.victron = next.victron || {};
  next.victron.transport = String(getValue('victronTransport') || 'modbus');
  next.victron.host = String(getValue('victronHost') || '');
  next.victron.port = Number(getValue('victronPort'));
  next.victron.unitId = Number(getValue('victronUnitId'));
  next.victron.timeoutMs = Number(getValue('victronTimeoutMs'));
  next.victron.mqtt = next.victron.mqtt || {};
  next.victron.mqtt.broker = String(getValue('mqttBroker') || '');
  next.victron.mqtt.portalId = String(getValue('mqttPortalId') || '');
  next.victron.mqtt.keepaliveIntervalMs = Number(getValue('mqttKeepalive'));

  next.meter = next.meter || {};
  next.meter.fc = Number(getValue('meterFc'));
  next.meter.address = Number(getValue('meterAddress'));
  next.meter.quantity = Number(getValue('meterQuantity'));

  next.dvControl = next.dvControl || {};
  next.dvControl.enabled = Boolean(getValue('dvControlEnabled'));

  next.epex = next.epex || {};
  next.epex.enabled = Boolean(getValue('epexEnabled'));
  next.epex.bzn = String(getValue('epexBzn') || 'DE-LU');
  next.epex.timezone = String(getValue('scheduleTimezone') || 'Europe/Berlin');

  next.influx = next.influx || {};
  next.influx.enabled = Boolean(getValue('influxEnabled'));
  next.influx.url = String(getValue('influxUrl') || '');
  next.influx.db = String(getValue('influxDb') || '');

  return next;
}

async function saveSetup(config, source = 'setup') {
  const res = await apiFetch(source === 'import' ? '/api/config/import' : '/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config })
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) {
    setBanner(`Setup konnte nicht gespeichert werden: ${payload.error || res.status}`, 'error');
    return false;
  }

  setStoredApiToken(payload.effectiveConfig?.apiToken || '');
  applyConfigToForm(payload.config, { meta: payload.meta, effectiveConfig: payload.effectiveConfig });
  const restartNote = payload.restartRequired ? ' Einige Einstellungen werden erst nach einem Dienst-Neustart aktiv.' : '';
  setBanner(`Setup gespeichert.${restartNote} Weiterleitung zu den Einstellungen...`, payload.restartRequired ? 'warn' : 'success');
  window.setTimeout(() => {
    window.location.href = '/settings.html?setup=done';
  }, 1200);
  return true;
}

async function loadSetup() {
  const res = await apiFetch('/api/config');
  const payload = await res.json();
  if (!res.ok || !payload.ok) {
    setBanner(`Setup konnte nicht geladen werden: ${payload.error || res.status}`, 'error');
    return;
  }
  applyConfigToForm(payload.config, payload);
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

document.getElementById('setupSaveBtn')?.addEventListener('click', () => {
  saveSetup(collectConfig()).catch((error) => setBanner(`Setup konnte nicht gespeichert werden: ${error.message}`, 'error'));
});

document.getElementById('setupImportBtn')?.addEventListener('click', () => {
  document.getElementById('setupImportFile')?.click();
});

document.getElementById('setupImportFile')?.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  await importSetupFile(file);
  event.target.value = '';
});

document.getElementById('victronTransport')?.addEventListener('change', updateTransportVisibility);

window.addEventListener('plexlite:unauthorized', () => {
  setBanner('API-Zugriff abgelehnt. Wenn ein Token aktiv ist, die Seite mit ?token=DEIN_TOKEN oeffnen.', 'error');
});

loadSetup().catch((error) => setBanner(`Setup konnte nicht geladen werden: ${error.message}`, 'error'));
