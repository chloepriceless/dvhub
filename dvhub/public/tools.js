(function() {
'use strict';
const common = window.DVhubCommon || {};
const { apiFetch, buildApiUrl } = common;

const HISTORY_FULL_BACKFILL_DEFAULT_LOOKBACK_DAYS = 14;
const HISTORY_FULL_BACKFILL_EXTENDED_LOOKBACK_DEFAULT_DAYS = 365;
const HISTORY_FULL_BACKFILL_MAX_LOOKBACK_DAYS = 365;

let currentHistoryImportStatus = null;
let currentHistoryImportResult = null;
let historyImportBusy = false;
let historyFullBackfillAcknowledged = false;
let historyFullBackfillExtendedLookbackEnabled = false;
let historyFullBackfillLookbackDays = String(HISTORY_FULL_BACKFILL_EXTENDED_LOOKBACK_DEFAULT_DAYS);
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

function buildHistoryGapBackfillRequest() {
  return {
    mode: 'gap',
    interval: '15mins'
  };
}

function normalizeHistoryFullBackfillLookbackDays(value, fallback = HISTORY_FULL_BACKFILL_EXTENDED_LOOKBACK_DEFAULT_DAYS) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(HISTORY_FULL_BACKFILL_MAX_LOOKBACK_DAYS, Math.max(1, numeric));
}

function buildHistoryFullBackfillRequest(options = {}) {
  const extendedLookbackEnabled = options?.extendedLookbackEnabled === true;
  return {
    mode: 'full',
    interval: '15mins',
    maxLookbackDays: extendedLookbackEnabled
      ? normalizeHistoryFullBackfillLookbackDays(options?.maxLookbackDays)
      : HISTORY_FULL_BACKFILL_DEFAULT_LOOKBACK_DAYS
  };
}

function buildMaintenanceBootstrapPlan() {
  return {
    loadSchedule: true,
    loadHistoryImportStatus: true,
    loadHealth: false,
    refreshScan: false,
    scanRefreshMs: 0
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
  if (status?.backfillRunning) return { disabled: true, reason: 'VRM-Backfill läuft bereits.' };
  if (!status?.enabled) return { disabled: true, reason: 'History-Import ist in der Konfiguration deaktiviert.' };
  if (!status?.ready) return { disabled: true, reason: 'VRM-Zugang ist noch nicht vollständig konfiguriert.' };
  return { disabled: false, reason: '' };
}

function buildHistoryFullBackfillActionState({ status, busy, acknowledged }) {
  const baseState = buildHistoryBackfillActionState({ status, busy });
  if (baseState.disabled) return baseState;
  if (!acknowledged) {
    return {
      disabled: true,
      reason: 'Bitte die Warnung fuer den Voll-Backfill erst explizit bestaetigen.'
    };
  }
  return { disabled: false, reason: '' };
}

function formatHistoryImportResult(result) {
  if (!result) return 'Noch kein Import gestartet.';
  if (!result.ok) return `Import fehlgeschlagen: ${result.error}`;
  if (result.mode === 'full') {
    return `Voll-Backfill gestartet: ${result.importedRows} Werte, ${result.importedWindows}/${result.windowsVisited} Fenster mit Daten, Job ${result.jobId}.`;
  }
  if (result.mode === 'gap') {
    return result.windowsVisited
      ? `Luecken-Backfill gestartet: ${result.importedRows} Werte, ${result.importedWindows}/${result.windowsVisited} offene Fenster bearbeitet, Job ${result.jobId}.`
      : 'Keine offenen VRM-Luecken gefunden.';
  }
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
  const fullBackfillState = buildHistoryFullBackfillActionState({
    status: currentHistoryImportStatus,
    busy: historyImportBusy,
    acknowledged: historyFullBackfillAcknowledged
  });
  const bannerText = !currentHistoryImportStatus
    ? 'VRM-Status wird geladen...'
    : currentHistoryImportStatus.backfillRunning
      ? 'VRM-Backfill laeuft gerade. Leitstand und Regelung bleiben verfuegbar, der Nachimport arbeitet im Hintergrund.'
    : !currentHistoryImportStatus.enabled
      ? 'VRM-Backfill ist derzeit deaktiviert.'
      : !currentHistoryImportStatus.ready
        ? 'VRM-Zugang ist noch nicht vollständig konfiguriert.'
        : `VRM verbunden fuer Portal ${currentHistoryImportStatus.vrmPortalId || '-'}. Lueckenabgleich und manueller Voll-Backfill sind bereit.`;
  const bannerKind = currentHistoryImportStatus?.backfillRunning ? 'warn' : (currentHistoryImportStatus?.ready ? 'success' : 'warn');
  setBanner('historyBanner', bannerText, bannerKind);

  const button = document.getElementById('historyImportBtn');
  if (button) {
    button.disabled = actionState.disabled;
    button.textContent = historyImportBusy ? 'VRM-Job läuft...' : 'VRM-Historie importieren';
  }
  const backfillButton = document.getElementById('historyBackfillBtn');
  if (backfillButton) {
    backfillButton.disabled = backfillState.disabled;
    backfillButton.textContent = historyImportBusy || currentHistoryImportStatus?.backfillRunning ? 'VRM-Job laeuft...' : 'VRM-Luecken schliessen';
  }
  const fullBackfillButton = document.getElementById('historyFullBackfillBtn');
  if (fullBackfillButton) {
    fullBackfillButton.disabled = fullBackfillState.disabled;
    fullBackfillButton.textContent = historyImportBusy || currentHistoryImportStatus?.backfillRunning ? 'VRM-Job laeuft...' : 'Voll-Backfill starten';
  }
  const fullAck = document.getElementById('historyFullBackfillAck');
  if (fullAck) {
    fullAck.checked = historyFullBackfillAcknowledged;
    fullAck.disabled = historyImportBusy || Boolean(currentHistoryImportStatus?.backfillRunning);
  }
  const extendedLookbackToggle = document.getElementById('historyFullBackfillExtendedLookback');
  if (extendedLookbackToggle) {
    extendedLookbackToggle.checked = historyFullBackfillExtendedLookbackEnabled;
    extendedLookbackToggle.disabled = historyImportBusy || Boolean(currentHistoryImportStatus?.backfillRunning);
  }
  const lookbackField = document.getElementById('historyFullBackfillLookbackField');
  if (lookbackField) {
    lookbackField.hidden = !historyFullBackfillExtendedLookbackEnabled;
  }
  const lookbackInput = document.getElementById('historyFullBackfillLookbackDays');
  if (lookbackInput) {
    lookbackInput.value = historyFullBackfillLookbackDays;
    lookbackInput.disabled = !historyFullBackfillExtendedLookbackEnabled
      || historyImportBusy
      || Boolean(currentHistoryImportStatus?.backfillRunning);
  }
  setText(
    'historyReason',
    actionState.reason
      || backfillState.reason
      || fullBackfillState.reason
      || 'Der normale Backfill prueft nur den letzten Zeitraum auf echte Luecken. Voll-Backfill zieht die komplette Historie erneut.'
  );

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

async function triggerHistoryBackfill(mode = 'gap') {
  historyImportBusy = true;
  renderHistoryImportState();
  const payload = mode === 'full'
    ? buildHistoryFullBackfillRequest({
      extendedLookbackEnabled: historyFullBackfillExtendedLookbackEnabled,
      maxLookbackDays: historyFullBackfillLookbackDays
    })
    : buildHistoryGapBackfillRequest();
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

// --- DV Signal Log ---
const DV_SIGNAL_TYPES = new Set([
  'ctrl_off', 'ctrl_on', 'ctrl_lease_expired',
  'dv_victron_write', 'dv_victron_write_error',
  'modbus_fc6', 'modbus_fc16',
  'negative_price_protection_on', 'negative_price_protection_off',
  'control_write', 'sma_plan_applied',
  'schedule_auto_disabled', 'schedule_stop_soc_reached'
]);

const DV_SIGNAL_LABELS = {
  ctrl_off: 'Abregelung',
  ctrl_on: 'Freigabe',
  ctrl_lease_expired: 'Lease abgelaufen',
  dv_victron_write: 'Victron Write',
  dv_victron_write_error: 'Victron Write Fehler',
  modbus_fc6: 'Modbus FC6 Write',
  modbus_fc16: 'Modbus FC16 Write',
  negative_price_protection_on: 'Negativpreis-Schutz AN',
  negative_price_protection_off: 'Negativpreis-Schutz AUS',
  control_write: 'Setpoint Write',
  sma_plan_applied: 'Börsenautomatik Plan',
  schedule_auto_disabled: 'Regel deaktiviert',
  schedule_stop_soc_reached: 'Stop-SoC erreicht'
};

const DV_SIGNAL_FILTER_MAP = {
  all: null,
  ctrl: ['ctrl_off', 'ctrl_on', 'ctrl_lease_expired', 'negative_price_protection_on', 'negative_price_protection_off'],
  modbus: ['modbus_fc6', 'modbus_fc16', 'control_write'],
  victron: ['dv_victron_write', 'dv_victron_write_error'],
  sma: ['sma_plan_applied', 'schedule_auto_disabled', 'schedule_stop_soc_reached']
};

let dvLogEntries = [];

async function loadDvSignalLog() {
  setText('dvLogMeta', 'Laden...');
  const source = document.getElementById('dvLogSource')?.value || 'ram';
  try {
    let rawEntries;
    if (source === 'db') {
      const res = await apiFetch('/api/log/dv-signals?limit=500');
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'DB-Abfrage fehlgeschlagen');
      rawEntries = (data.rows || []).map((e) => ({
        ...e,
        type: e.event,
        detail: { ...(e.meta || {}), reason: e.reason, source: e.source, target: e.target, value: e.value }
      }));
    } else {
      const res = await apiFetch('/api/log?limit=1000');
      const data = await res.json();
      rawEntries = Array.isArray(data?.rows) ? data.rows : (Array.isArray(data) ? data : []);
      rawEntries = rawEntries.map((e) => ({
        ...e,
        type: e.type || e.event,
        detail: e.detail || e
      }));
    }
    dvLogEntries = source === 'db' ? rawEntries : rawEntries.filter((e) => DV_SIGNAL_TYPES.has(e.type));
    renderDvSignalLog();
    const label = source === 'db' ? 'Datenbank (persistent)' : 'RAM (aktuelle Sitzung)';
    setText('dvLogMeta', `${dvLogEntries.length} DV-Signale aus ${label}`);
  } catch (error) {
    setText('dvLogMeta', `Fehler: ${error.message}`);
  }
}

function renderDvSignalLog() {
  const tbody = document.getElementById('dvLogRows');
  if (!tbody) return;
  const filterKey = document.getElementById('dvLogFilter')?.value || 'all';
  const allowed = DV_SIGNAL_FILTER_MAP[filterKey];
  const filtered = allowed ? dvLogEntries.filter((e) => allowed.includes(e.type)) : dvLogEntries;

  tbody.innerHTML = '';
  for (const entry of filtered.slice(0, 200)) {
    const tr = document.createElement('tr');
    const isError = entry.type.includes('error') || entry.type === 'ctrl_off' || entry.type === 'neg_price_cutoff' || entry.type === 'schedule_auto_disabled' || entry.type === 'schedule_stop_soc_reached';
    const isOk = entry.type === 'ctrl_on' || entry.type === 'neg_price_restore' || entry.type === 'sma_plan_applied';
    const isInfo = entry.type === 'control_write';
    tr.style.color = isError ? '#ef4444' : (isOk ? '#22c55e' : (isInfo ? '#3b82f6' : ''));

    const tdTime = document.createElement('td');
    tdTime.textContent = fmtTs(entry.ts);
    tr.appendChild(tdTime);

    const tdType = document.createElement('td');
    tdType.textContent = DV_SIGNAL_LABELS[entry.type] || entry.type;
    tr.appendChild(tdType);

    const tdDetail = document.createElement('td');
    const detail = entry.detail || entry.data || {};
    const parts = [];
    if (detail.reason) parts.push(`Grund: ${detail.reason}`);
    if (detail.register) parts.push(`Register: ${detail.register}`);
    if (detail.address !== undefined) parts.push(`Addr: ${detail.address}`);
    if (detail.value !== undefined) parts.push(`Wert: ${detail.value}`);
    if (detail.remote) parts.push(`Remote: ${detail.remote}`);
    if (detail.feedIn !== undefined) parts.push(`Feed-In: ${detail.feedIn}`);
    if (detail.forcedOff !== undefined) parts.push(`Abgeregelt: ${detail.forcedOff}`);
    if (detail.price !== undefined) parts.push(`Preis: ${detail.price} ct/kWh`);
    if (detail.limit !== undefined) parts.push(`Limit: ${detail.limit} W`);
    if (detail.error) parts.push(`Fehler: ${detail.error}`);
    if (detail.offUntil) parts.push(`Bis: ${fmtTs(detail.offUntil)}`);
    if (detail.values) parts.push(`Values: [${detail.values}]`);
    if (detail.qty !== undefined) parts.push(`Qty: ${detail.qty}`);
    if (detail.target) parts.push(`Ziel: ${detail.target}`);
    if (detail.source) parts.push(`Quelle: ${detail.source}`);
    if (detail.raw !== undefined) parts.push(`Raw: ${detail.raw}`);
    if (detail.scaled !== undefined) parts.push(`Skaliert: ${detail.scaled}`);
    if (detail.writeType) parts.push(`Typ: ${detail.writeType}`);
    if (detail.fc !== undefined) parts.push(`FC: ${detail.fc}`);
    if (detail.slots !== undefined) parts.push(`Slots: ${detail.slots}`);
    if (detail.energyKwh !== undefined) parts.push(`Energie: ${detail.energyKwh} kWh`);
    if (detail.estimatedRevenueEur !== undefined) parts.push(`Erlös: ${detail.estimatedRevenueEur} €`);
    if (detail.soc !== undefined) parts.push(`SoC: ${detail.soc}%`);
    if (detail.id) parts.push(`Regel: ${detail.id}`);
    tdDetail.textContent = parts.length > 0 ? parts.join(' | ') : JSON.stringify(detail);
    tr.appendChild(tdDetail);

    tbody.appendChild(tr);
  }
  if (filtered.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3;
    td.textContent = 'Keine DV-Signale im aktuellen Log.';
    td.style.textAlign = 'center';
    td.style.color = '#888';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

// --- Software Update ---
async function checkForUpdate() {
  setBanner('updateBanner', 'Prüfe auf Updates...', 'info');
  document.getElementById('updateChangelog').style.display = 'none';
  document.getElementById('updateActions').style.display = 'none';
  try {
    const res = await apiFetch('/api/admin/update/check');
    const data = await res.json();
    if (!data.ok) {
      setBanner('updateBanner', `Fehler: ${data.error}`, 'error');
      setText('updateMeta', '-');
      return;
    }
    // Sync channel dropdown with server state
    const channelSelect = document.getElementById('updateChannel');
    if (channelSelect && data.channel) channelSelect.value = data.channel;

    if (data.channel === 'stable') {
      const currentLabel = data.current.tag || data.current.revision;
      const latestLabel = data.latest.tag || 'unbekannt';
      setText('updateMeta', `Channel: Stable | Aktuell: ${currentLabel} | Neueste Version: ${latestLabel}`);
      if (data.updateAvailable) {
        setBanner('updateBanner', `Neue Version verfügbar: ${data.latest.tag}`, 'warning');
      } else {
        setBanner('updateBanner', `DVhub ist aktuell — ${currentLabel}`, 'success');
      }
    } else {
      setText('updateMeta', `Channel: Dev | Aktuell: ${data.current.revision} | Remote: ${data.latest.revision}${data.behind ? ` | ${data.behind} Commits hinter main` : ''}${data.ahead ? ` | ${data.ahead} voraus` : ''}`);
      if (data.updateAvailable) {
        setBanner('updateBanner', `Update verfügbar! ${data.behind} Commit${data.behind > 1 ? 's' : ''} hinter origin/main.`, 'warning');
      } else {
        setBanner('updateBanner', 'DVhub ist aktuell — keine Updates verfügbar.', 'success');
      }
    }

    if (data.updateAvailable) {
      const changelogDiv = document.getElementById('updateChangelog');
      if (data.changelog && data.changelog.length) {
        changelogDiv.innerHTML = '<p class="card-title">Änderungen:</p>' +
          data.changelog.map(line => {
            const el = document.createElement('div');
            el.className = 'summary-card';
            el.textContent = line;
            return el.outerHTML;
          }).join('');
        changelogDiv.style.display = '';
      }
      document.getElementById('updateActions').style.display = '';
    }
  } catch (error) {
    setBanner('updateBanner', `Update-Check fehlgeschlagen: ${error.message}`, 'error');
  }
}

async function applyUpdate() {
  const btn = document.getElementById('applyUpdateBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Update läuft...'; }
  setBanner('updateBanner', 'Update wird installiert — bitte warten...', 'info');
  try {
    const res = await apiFetch('/api/admin/update/apply', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      setBanner('updateBanner', 'Update installiert! Service startet neu — Seite lädt in 10 Sekunden automatisch neu.', 'success');
      document.getElementById('updateActions').style.display = 'none';
      setTimeout(() => window.location.reload(), 10000);
    } else {
      setBanner('updateBanner', `Update fehlgeschlagen: ${data.error}`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Update installieren & neu starten'; }
    }
  } catch (error) {
    setBanner('updateBanner', `Update fehlgeschlagen: ${error.message}`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Update installieren & neu starten'; }
  }
}

async function switchUpdateChannel(newChannel) {
  const channelSelect = document.getElementById('updateChannel');
  const previousChannel = newChannel === 'stable' ? 'dev' : 'stable';
  const revertDropdown = () => { if (channelSelect) channelSelect.value = previousChannel; };

  const label = newChannel === 'stable' ? 'Stable (Releases)' : 'Bleeding Edge (Dev Commits)';
  if (!confirm(`Wechsel zu ${label}?\n\nDVhub wird auf den ${newChannel === 'stable' ? 'neuesten Release-Tag' : 'aktuellen main-Branch'} umgestellt und neu gestartet.`)) {
    revertDropdown();
    return;
  }
  setBanner('updateBanner', `Wechsel zu ${label} — bitte warten...`, 'info');
  try {
    const res = await apiFetch('/api/admin/update/channel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: newChannel })
    });
    const data = await res.json();
    if (data.ok) {
      setBanner('updateBanner', `Channel gewechselt zu ${label}. Service startet neu — Seite lädt in 10 Sekunden automatisch neu.`, 'success');
      setTimeout(() => window.location.reload(), 10000);
    } else {
      setBanner('updateBanner', `Channel-Wechsel fehlgeschlagen: ${data.error}`, 'error');
      revertDropdown();
    }
  } catch (error) {
    setBanner('updateBanner', `Channel-Wechsel fehlgeschlagen: ${error.message}`, 'error');
    revertDropdown();
  }
}

function initToolsPage() {
  const bootstrapPlan = buildMaintenanceBootstrapPlan();
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
  document.getElementById('checkUpdateBtn')?.addEventListener('click', () => checkForUpdate());
  document.getElementById('applyUpdateBtn')?.addEventListener('click', () => applyUpdate());
  document.getElementById('updateChannel')?.addEventListener('change', (e) => switchUpdateChannel(e.target.value));
  document.getElementById('loadDvLog')?.addEventListener('click', () => loadDvSignalLog());
  document.getElementById('refreshDvLog')?.addEventListener('click', () => loadDvSignalLog());
  document.getElementById('dvLogFilter')?.addEventListener('change', () => renderDvSignalLog());
  document.getElementById('dvLogSource')?.addEventListener('change', () => loadDvSignalLog());
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
  document.getElementById('historyFullBackfillAck')?.addEventListener('change', (event) => {
    historyFullBackfillAcknowledged = event.target.checked === true;
    renderHistoryImportState();
  });
  document.getElementById('historyFullBackfillExtendedLookback')?.addEventListener('change', (event) => {
    historyFullBackfillExtendedLookbackEnabled = event.target.checked === true;
    if (historyFullBackfillExtendedLookbackEnabled && !historyFullBackfillLookbackDays) {
      historyFullBackfillLookbackDays = String(HISTORY_FULL_BACKFILL_EXTENDED_LOOKBACK_DEFAULT_DAYS);
    }
    renderHistoryImportState();
  });
  document.getElementById('historyFullBackfillLookbackDays')?.addEventListener('change', (event) => {
    historyFullBackfillLookbackDays = String(
      normalizeHistoryFullBackfillLookbackDays(
        event.target.value,
        HISTORY_FULL_BACKFILL_EXTENDED_LOOKBACK_DEFAULT_DAYS
      )
    );
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
    triggerHistoryBackfill('gap').catch((error) => {
      currentHistoryImportResult = { ok: false, error: error.message };
      historyImportBusy = false;
      renderHistoryImportState();
    });
  });
  document.getElementById('historyFullBackfillBtn')?.addEventListener('click', () => {
    triggerHistoryBackfill('full').catch((error) => {
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
  if (bootstrapPlan.loadSchedule) {
    loadSchedule().catch((error) => setText('scheduleMeta', `Laden fehlgeschlagen: ${error.message}`));
  }
  if (bootstrapPlan.refreshScan) {
    refreshScan().catch((error) => setText('scanMeta', `Scan fehlgeschlagen: ${error.message}`));
  }
  if (bootstrapPlan.loadHealth) {
    loadHealth().catch((error) => setBanner('healthBanner', `Health-Status konnte nicht geladen werden: ${error.message}`, 'error'));
  }
  // Auto-check for updates on page load
  checkForUpdate().catch(() => {});
  if (bootstrapPlan.loadHistoryImportStatus) {
    loadHistoryImportStatus().catch((error) => {
      currentHistoryImportResult = { ok: false, error: error.message };
      renderHistoryImportState();
    });
  }
  if (bootstrapPlan.scanRefreshMs > 0) {
    window.setInterval(() => {
      refreshScan().catch((error) => setText('scanMeta', `Scan fehlgeschlagen: ${error.message}`));
    }, bootstrapPlan.scanRefreshMs);
  }
}

if (typeof document !== 'undefined') {
  initToolsPage();
}

if (typeof globalThis !== 'undefined') {
  globalThis.DVhubToolsHistory = {
    buildMaintenanceBootstrapPlan,
    buildHistoryImportRequest,
    buildHistoryGapBackfillRequest,
    buildHistoryFullBackfillRequest,
    normalizeHistoryFullBackfillLookbackDays,
    buildHistoryImportActionState,
    buildHistoryBackfillActionState,
    buildHistoryFullBackfillActionState,
    formatHistoryImportResult
  };
}
})();
