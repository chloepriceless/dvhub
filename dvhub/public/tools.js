const common = window.DVhubCommon || {};
const { apiFetch, buildApiUrl } = common;

let currentHistoryImportStatus = null;
let currentHistoryImportResult = null;
let historyImportBusy = false;
let historyImportFormState = {
  start: '',
  end: ''
};

function fmtTs(ts) {
  return ts ? new Date(ts).toLocaleString('de-DE') : '-';
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setBanner(id, text, kind = 'info') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `status-banner ${kind}`;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

function buildHistoryImportActionState({ status, form, busy }) {
  if (busy) return { disabled: true, reason: 'Import läuft bereits.' };
  if (!status?.enabled) return { disabled: true, reason: 'History-Import ist in der Konfiguration deaktiviert.' };
  if (!status?.ready) return { disabled: true, reason: 'VRM-Zugang ist noch nicht vollständig konfiguriert.' };
  const payload = buildHistoryImportRequest(form);
  if (!payload.start || !payload.end) return { disabled: true, reason: 'Bitte Start und Ende setzen.' };
  if (new Date(payload.end).getTime() <= new Date(payload.start).getTime()) {
    return { disabled: true, reason: 'Das Ende muss nach dem Start liegen.' };
  }
  return { disabled: false, reason: '' };
}

function buildHistoryBackfillActionState({ status, busy }) {
  if (busy) return { disabled: true, reason: 'Import läuft bereits.' };
  if (!status?.enabled) return { disabled: true, reason: 'History-Import ist in der Konfiguration deaktiviert.' };
  if (!status?.ready) return { disabled: true, reason: 'VRM-Zugang ist noch nicht vollständig konfiguriert.' };
  return { disabled: false, reason: '' };
}

function formatHistoryImportResult(result) {
  if (!result) return 'Noch kein Import gestartet.';
  if (!result.ok) return `Import fehlgeschlagen: ${result.error}`;
  if (result.windowsVisited != null) {
    return `Backfill gestartet: ${result.importedRows} Werte, ${result.importedWindows}/${result.windowsVisited} Fenster mit Daten, Job ${result.jobId}.`;
  }
  return `Import erfolgreich: ${result.importedRows} Werte, Job ${result.jobId}.`;
}

function syncHistoryImportFormState() {
  historyImportFormState = {
    start: document.getElementById('historyImportStart')?.value || '',
    end: document.getElementById('historyImportEnd')?.value || ''
  };
}

function renderHistoryImportState() {
  const actionState = buildHistoryImportActionState({
    status: currentHistoryImportStatus,
    form: historyImportFormState,
    busy: historyImportBusy
  });
  const backfillState = buildHistoryBackfillActionState({
    status: currentHistoryImportStatus,
    busy: historyImportBusy
  });
  const bannerText = !currentHistoryImportStatus
    ? 'VRM-Status wird geladen...'
    : !currentHistoryImportStatus.enabled
      ? 'VRM-Backfill ist derzeit deaktiviert.'
      : !currentHistoryImportStatus.ready
        ? 'VRM-Zugang ist noch nicht vollständig konfiguriert.'
        : `VRM verbunden für Portal ${currentHistoryImportStatus.vrmPortalId || '-'}. Historischer Nachimport ist bereit.`;
  const bannerKind = currentHistoryImportStatus?.ready ? 'success' : 'warn';
  setBanner('historyBanner', bannerText, bannerKind);

  const button = document.getElementById('historyImportBtn');
  if (button) {
    button.disabled = actionState.disabled;
    button.textContent = historyImportBusy ? 'VRM-Job läuft...' : 'VRM-Historie importieren';
  }
  const backfillButton = document.getElementById('historyBackfillBtn');
  if (backfillButton) {
    backfillButton.disabled = backfillState.disabled;
    backfillButton.textContent = historyImportBusy ? 'VRM-Job läuft...' : 'VRM-Backfill starten';
  }
  setText('historyReason', actionState.reason || backfillState.reason || 'Importiert einen expliziten Zeitraum oder startet einen automatischen VRM-Backfill bis zur ersten leeren Historie.');

  if (currentHistoryImportResult) {
    setBanner(
      'historyResult',
      formatHistoryImportResult(currentHistoryImportResult),
      currentHistoryImportResult.ok ? 'success' : 'error'
    );
  }
}

function renderScan(scan) {
  setText('scanMeta', scan.running ? 'Scan läuft...' : `Last update: ${fmtTs(scan.updatedAt)} | Rows: ${(scan.rows || []).length}`);
  const tbody = document.getElementById('scanRows');
  if (!tbody) return;
  tbody.innerHTML = '';
  const rows = (scan.rows || []).slice(0, 300);
  for (const r of rows) {
    const tr = document.createElement('tr');
    const tdAddr = document.createElement('td');
    tdAddr.textContent = r.addr ?? '-';
    const tdU16 = document.createElement('td');
    tdU16.textContent = Array.isArray(r.regs) ? r.regs.join(', ') : '-';
    const tdS16 = document.createElement('td');
    tdS16.textContent = Array.isArray(r.s16) ? r.s16.join(', ') : '-';
    const tdStatus = document.createElement('td');
    tdStatus.textContent = r.error ? 'ERR: ' + r.error : 'OK';
    tr.appendChild(tdAddr);
    tr.appendChild(tdU16);
    tr.appendChild(tdS16);
    tr.appendChild(tdStatus);
    tbody.appendChild(tr);
  }
}

function renderHealth(payload) {
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
  setText('serviceMeta', `Service: ${service.name || '-'} | Status: ${service.status || '-'} | Runtime: ${payload.runtime?.node || '-'} | Geprüft: ${fmtTs(payload.checkedAt)}`);
  const restartButton = document.getElementById('restartServiceBtn');
  if (restartButton) restartButton.disabled = !(service.enabled && service.status !== 'unavailable');

  if (!service.enabled) setBanner('healthBanner', 'Restart-Aktionen sind deaktiviert. Aktivierung erfolgt über den Installer bzw. ENV-Variablen.', 'warn');
  else if (service.status === 'unavailable') setBanner('healthBanner', `Service-Check fehlgeschlagen: ${service.detail || 'systemctl nicht erreichbar'}`, 'error');
  else setBanner('healthBanner', `Service ${service.name} ist erreichbar. Status: ${service.status}.`, 'success');
}

async function refreshScan() {
  const res = await apiFetch('/api/meter/scan');
  const scan = await res.json();
  renderScan(scan);
}

async function startScan() {
  const body = {
    unitId: Number(document.getElementById('scanUnit').value),
    start: Number(document.getElementById('scanStart').value),
    end: Number(document.getElementById('scanEnd').value),
    step: Number(document.getElementById('scanStep').value),
    quantity: Number(document.getElementById('scanQty').value)
  };
  await apiFetch('/api/meter/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  await refreshScan();
}

async function loadSchedule() {
  const res = await apiFetch('/api/schedule');
  const data = await res.json();
  const scheduleJson = document.getElementById('scheduleJson');
  if (scheduleJson) scheduleJson.value = JSON.stringify({ rules: data.rules || [] }, null, 2);
  setText('scheduleMeta', `geladen: ${fmtTs(Date.now())}`);
}

async function saveSchedule() {
  try {
    const payload = JSON.parse(document.getElementById('scheduleJson').value || '{}');
    const res = await apiFetch('/api/schedule/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const out = await res.json();
    setText('scheduleMeta', out.ok ? `gespeichert (${out.count})` : `Fehler: ${out.error || 'unknown'}`);
  } catch (e) {
    setText('scheduleMeta', `JSON Fehler: ${e.message}`);
  }
}

async function loadHealth() {
  const res = await apiFetch('/api/admin/health');
  const payload = await res.json();
  if (!res.ok || !payload.ok) {
    setBanner('healthBanner', `Health-Status konnte nicht geladen werden: ${payload.error || res.status}`, 'error');
    return;
  }
  renderHealth(payload);
}

async function restartService() {
  const res = await apiFetch('/api/admin/service/restart', { method: 'POST' });
  const payload = await res.json();
  if (!res.ok || !payload.ok) {
    setBanner('healthBanner', `Restart fehlgeschlagen: ${payload.error || res.status}`, 'error');
    return;
  }
  setBanner('healthBanner', 'Restart wurde angefordert. Die Seite versucht sich gleich neu zu verbinden.', 'warn');
  window.setTimeout(() => window.location.reload(), 8000);
}

function exportConfig() {
  window.location.href = buildApiUrl('/api/config/export');
  setBanner('importBanner', 'Config-Export wurde gestartet.', 'success');
}

async function importConfigFromFile(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const res = await apiFetch('/api/config/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: parsed })
    });
    const payload = await res.json();
    if (!res.ok || !payload.ok) {
      setBanner('importBanner', `Import fehlgeschlagen: ${payload.error || res.status}`, 'error');
      return;
    }
    const warningCount = Array.isArray(payload.meta?.warnings) ? payload.meta.warnings.length : 0;
    setBanner('importBanner', `Config importiert.${warningCount ? ` ${warningCount} Warnungen prüfen.` : ''}`, warningCount ? 'warn' : 'success');
    setText('importMeta', `Datei: ${payload.meta?.path || '-'} | Gültig: ${payload.meta?.valid ? 'Ja' : 'Nein'} | Warnungen: ${warningCount}`);
  } catch (error) {
    setBanner('importBanner', `Import fehlgeschlagen: ${error.message}`, 'error');
  }
}

async function loadHistoryImportStatus() {
  const res = await apiFetch('/api/history/import/status');
  const payload = await res.json();
  if (!res.ok || !payload.ok) {
    currentHistoryImportStatus = {
      enabled: false,
      ready: false,
      provider: 'vrm',
      vrmPortalId: ''
    };
    currentHistoryImportResult = { ok: false, error: payload.error || String(res.status) };
    renderHistoryImportState();
    return;
  }
  currentHistoryImportStatus = payload.historyImport || null;
  renderHistoryImportState();
}

async function triggerHistoryImport() {
  historyImportBusy = true;
  renderHistoryImportState();
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
  renderHistoryImportState();
  if (!res.ok || !body.ok) throw new Error(body.error || String(res.status));
}

async function triggerHistoryBackfill() {
  historyImportBusy = true;
  renderHistoryImportState();
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
  renderHistoryImportState();
  if (!res.ok || !body.ok) throw new Error(body.error || String(res.status));
}

function initToolsPage() {
  document.getElementById('startScan')?.addEventListener('click', () => {
    startScan().catch((error) => setText('scanMeta', `Scan fehlgeschlagen: ${error.message}`));
  });
  document.getElementById('loadSchedule')?.addEventListener('click', () => {
    loadSchedule().catch((error) => setText('scheduleMeta', `Laden fehlgeschlagen: ${error.message}`));
  });
  document.getElementById('saveSchedule')?.addEventListener('click', () => {
    saveSchedule().catch((error) => setText('scheduleMeta', `Speichern fehlgeschlagen: ${error.message}`));
  });
  document.getElementById('refreshHealthBtn')?.addEventListener('click', () => {
    loadHealth().catch((error) => setBanner('healthBanner', `Health-Status konnte nicht geladen werden: ${error.message}`, 'error'));
  });
  document.getElementById('restartServiceBtn')?.addEventListener('click', () => {
    restartService().catch((error) => setBanner('healthBanner', `Restart fehlgeschlagen: ${error.message}`, 'error'));
  });
  document.getElementById('exportConfigBtn')?.addEventListener('click', exportConfig);
  document.getElementById('importConfigBtn')?.addEventListener('click', () => {
    document.getElementById('importConfigFile')?.click();
  });
  document.getElementById('importConfigFile')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    await importConfigFromFile(file);
    event.target.value = '';
  });
  document.getElementById('refreshHistoryBtn')?.addEventListener('click', () => {
    loadHistoryImportStatus().catch((error) => {
      currentHistoryImportResult = { ok: false, error: error.message };
      renderHistoryImportState();
    });
  });
  document.getElementById('historyImportStart')?.addEventListener('change', () => {
    syncHistoryImportFormState();
    renderHistoryImportState();
  });
  document.getElementById('historyImportEnd')?.addEventListener('change', () => {
    syncHistoryImportFormState();
    renderHistoryImportState();
  });
  document.getElementById('historyImportBtn')?.addEventListener('click', () => {
    triggerHistoryImport().catch((error) => {
      currentHistoryImportResult = { ok: false, error: error.message };
      historyImportBusy = false;
      renderHistoryImportState();
    });
  });
  document.getElementById('historyBackfillBtn')?.addEventListener('click', () => {
    triggerHistoryBackfill().catch((error) => {
      currentHistoryImportResult = { ok: false, error: error.message };
      historyImportBusy = false;
      renderHistoryImportState();
    });
  });

  window.addEventListener('dvhub:unauthorized', () => {
    setText('scanMeta', 'API-Zugriff verweigert. Falls ein API-Token gesetzt ist, Seite mit ?token=DEIN_TOKEN öffnen.');
    setText('scheduleMeta', 'API-Zugriff verweigert. Falls ein API-Token gesetzt ist, Seite mit ?token=DEIN_TOKEN öffnen.');
    setBanner('healthBanner', 'API-Zugriff verweigert. Falls ein API-Token gesetzt ist, Seite mit ?token=DEIN_TOKEN öffnen.', 'error');
    setBanner('importBanner', 'API-Zugriff verweigert. Falls ein API-Token gesetzt ist, Seite mit ?token=DEIN_TOKEN öffnen.', 'error');
    setBanner('historyBanner', 'API-Zugriff verweigert. Falls ein API-Token gesetzt ist, Seite mit ?token=DEIN_TOKEN öffnen.', 'error');
  });

  syncHistoryImportFormState();
  loadSchedule().catch((error) => setText('scheduleMeta', `Laden fehlgeschlagen: ${error.message}`));
  refreshScan().catch((error) => setText('scanMeta', `Scan fehlgeschlagen: ${error.message}`));
  loadHealth().catch((error) => setBanner('healthBanner', `Health-Status konnte nicht geladen werden: ${error.message}`, 'error'));
  loadHistoryImportStatus().catch((error) => {
    currentHistoryImportResult = { ok: false, error: error.message };
    renderHistoryImportState();
  });
  window.setInterval(() => {
    refreshScan().catch((error) => setText('scanMeta', `Scan fehlgeschlagen: ${error.message}`));
  }, 3000);
}

if (typeof document !== 'undefined') {
  initToolsPage();
}
