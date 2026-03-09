const { apiFetch } = window.DVhubCommon;

function fmtTs(ts) { return ts ? new Date(ts).toLocaleString('de-DE') : '-'; }
function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderScan(scan) {
  setText('scanMeta', scan.running ? 'Scan läuft...' : `Last update: ${fmtTs(scan.updatedAt)} | Rows: ${(scan.rows || []).length}`);
  const tbody = document.getElementById('scanRows');
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
  document.getElementById('scheduleJson').value = JSON.stringify({ rules: data.rules || [] }, null, 2);
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

document.getElementById('startScan').addEventListener('click', startScan);
document.getElementById('loadSchedule').addEventListener('click', loadSchedule);
document.getElementById('saveSchedule').addEventListener('click', saveSchedule);

window.addEventListener('dvhub:unauthorized', () => {
  setText('scanMeta', 'API-Zugriff verweigert. Falls ein API-Token gesetzt ist, Seite mit ?token=DEIN_TOKEN öffnen.');
  setText('scheduleMeta', 'API-Zugriff verweigert. Falls ein API-Token gesetzt ist, Seite mit ?token=DEIN_TOKEN öffnen.');
});

loadSchedule();
refreshScan();
setInterval(refreshScan, 3000);
