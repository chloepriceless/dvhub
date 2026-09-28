// installer-portal/public/app.js — Frontend-Logik (vanilla JS, kein Framework)
// Pull-Modell: die Anlage meldet sich bei uns; hier erzeugt der Installateur
// den Kopplungs-Code zur Appliance-ID und gibt eingehende Anfragen frei.
'use strict';

const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

let mode = 'register'; // auth-Tab
let pairings = [];
let refreshTimer = null;
let isAdminUser = false;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let j = {};
  try { j = await res.json(); } catch { /* html oder leer */ }
  return { status: res.status, j };
}

function setView() {
  const authed = !!localStorage.getItem('dvportal-name');
  $('#authView').hidden = authed;
  $('#mainView').hidden = !authed;
  $('#adminView').hidden = true;
  $('#logoutBtn').hidden = !authed;
  $('#adminBtn').hidden = !(authed && isAdminUser);
  $('#whoami').textContent = authed ? localStorage.getItem('dvportal-name') : '';
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (authed) {
    refreshPairings();
    refreshTimer = setInterval(refreshPairings, 10000);
  }
}

function showAdmin(on) {
  $('#mainView').hidden = !on ? false : true;
  $('#adminView').hidden = !on;
  if (on) refreshAdmin();
}
$('#adminBtn')?.addEventListener('click', () => showAdmin(true));
$('#adminBackBtn')?.addEventListener('click', () => showAdmin(false));

// ── Auth ─────────────────────────────────────────────────────────────────────
function setMode(m) {
  mode = m;
  $('#tabRegister').classList.toggle('active', m === 'register');
  $('#tabLogin').classList.toggle('active', m === 'login');
  $('#companyField').hidden = m === 'login';
  $('#setupField').hidden = m === 'login';
  $('#totpField').hidden = m !== 'login';
  $('#passkeyLoginBtn').hidden = m !== 'login';
  $('#authSubmit').textContent = m === 'register' ? 'Registrieren' : 'Anmelden';
  $('#authMsg').textContent = '';
}
$('#tabRegister').addEventListener('click', () => setMode('register'));
$('#tabLogin').addEventListener('click', () => setMode('login'));

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#authName').value.trim();
  const password = $('#authPass').value;
  const msg = $('#authMsg');
  msg.textContent = '…';
  const { status, j } = mode === 'register'
    ? await api('/api/account', { method: 'POST', body: { name, company: $('#authCompany').value.trim(), password, setupToken: $('#authSetupToken').value || undefined } })
    : await api('/api/login', { method: 'POST', body: { name, password, totp: $('#authTotp').value.trim() || undefined } });
  if (!j.ok) {
    // 2FA: Feld einblenden und Fokus — der Nutzer hat das Passwort schon
    // korrekt eingetragen, jetzt fehlt/nur der Authenticator-Code.
    if (j.error === 'totp_ausstaendig' || j.error === 'totp_falsch') {
      $('#totpField').hidden = false;
      $('#authTotp').focus();
      msg.textContent = j.error === 'totp_falsch' ? '2FA-Code falsch — noch einmal versuchen.' : 'Bitte 2FA-Code aus deiner Authenticator-App eingeben.';
      return;
    }
    msg.textContent = { 'konto_existiert_bereits': 'Konto existiert bereits — bitte anmelden.',
      'name_reserviert': 'Dieser Name ist für Admins reserviert (Admin-Setup-Token nötig).',
      'anmeldung_fehlgeschlagen': 'Anmeldung fehlgeschlagen — Name oder Passwort falsch.',
      'rate_limited': 'Zu viele Versuche — bitte eine Minute warten.',
      'name_ungueltig': 'Name ungültig (max. 80 Zeichen, keine Steuerzeichen).',
    }[j.error] || `Fehler: ${j.error || status}`;
    return;
  }
  localStorage.setItem('dvportal-name', j.name);
  $('#authPass').value = ''; $('#authTotp').value = '';
  await refreshMe();
  setView();
});

// ── Passkeys (WebAuthn) ──────────────────────────────────────────────────────
const b64ToBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const bufToB64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

$('#passkeyLoginBtn').addEventListener('click', async () => {
  const msg = $('#authMsg');
  const name = $('#authName').value.trim();
  if (!name) { msg.textContent = 'Erst den Kontonamen eintragen.'; return; }
  try {
    msg.textContent = 'Warte auf Passkey…';
    const { status, j } = await api('/api/passkey/login-begin', { method: 'POST', body: { name } });
    if (!j.ok) { msg.textContent = 'Passkey-Login für dieses Konto nicht verfügbar.'; return; }
    const assert = await navigator.credentials.get({ publicKey: {
      challenge: b64ToBuf(j.challenge),
      allowCredentials: (j.allow || []).map((id) => ({ id: b64ToBuf(id), type: 'public-key' })),
      userVerification: 'required', timeout: 60000,
    } });
    const r = await api('/api/passkey/login-finish', { method: 'POST', body: {
      name, id: assert.id, challenge: j.challenge,
      authenticatorData: bufToB64(assert.response.authenticatorData),
      clientDataJSON: bufToB64(assert.response.clientDataJSON),
      signature: bufToB64(assert.response.signature),
    } });
    if (!r.j.ok) { msg.textContent = `Passkey abgelehnt: ${r.j.error || r.status}`; return; }
    localStorage.setItem('dvportal-name', r.j.name);
    await refreshMe();
    setView();
  } catch (e) {
    msg.textContent = e.name === 'NotAllowedError' ? 'Passkey-Abbruch.' : `Passkey-Fehler: ${e.message}`;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  localStorage.removeItem('dvportal-name');
  setView();
});

// ── Pairings ─────────────────────────────────────────────────────────────────
$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#addMsg');
  msg.textContent = 'Erzeuge Kopplungs-Code…';
  const { j } = await api('/api/pairings', {
    method: 'POST',
    body: {
      applianceId: $('#addApplianceId').value.trim(),
      name: $('#addName').value.trim(),
      customer: $('#addCustomer').value.trim(),
      sizeKwp: $('#addSize')?.value.trim() || undefined,
    },
  });
  if (!j.ok) {
    msg.textContent = { 'anlage_bereits_gekoppelt': 'Diese Anlage ist bereits gekoppelt.',
      'anlage_bei_anderem_installateur_in_kopplung': 'Für diese Anlage läuft gerade eine Kopplung eines anderen Installateurs.',
      'appliance_id_ungültig': 'Appliance-ID ungültig — steht in der DVhub-Oberfläche unter Einstellungen → Status.',
    }[j.error] || `Fehler: ${j.error || 'unbekannt'}`;
    return;
  }
  $('#addForm').reset();
  msg.textContent = '';
  refreshPairings();
});

async function refreshPairings() {
  const { status, j } = await api('/api/pairings');
  if (status === 401) { localStorage.removeItem('dvportal-name'); setView(); return; }
  pairings = j.pairings || [];
  render();
}

const fmtW = (w) => w == null ? '–' : `${Math.round(w)} W`;
const fmtPct = (v) => v == null ? '–' : `${Math.round(v)} %`;
const fmtAge = (iso) => {
  if (!iso) return 'noch nie';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `vor ${s} s`;
  if (s < 3600) return `vor ${Math.round(s / 60)} min`;
  return `vor ${Math.round(s / 3600)} h`;
};

const STATUS = {
  waiting:   ['wartet auf Anlage', 'warn'],
  requested: ['Anfrage eingetroffen', 'teal'],
  approved:  ['verbunden', 'ok'],
  declined:  ['abgelehnt', 'err'],
};

function render() {
  const list = $('#pairingList');
  list.replaceChildren();
  const tpl = $('#pairTpl');
  for (const pr of pairings) {
    const node = tpl.content.cloneNode(true);
    const card = node.querySelector('.appliance');
    // Anzeige: Installateur-Vergabe hat Vorrang, dann Anlagen-Reportierung.
    $('.ap-name', card).textContent = pr.name || pr.applianceName || 'Anlage';
    const custEl = $('.ap-customer', card);
    if (pr.customer) { custEl.hidden = false; custEl.textContent = `Kunde: ${pr.customer}`; }
    $('.ap-meta', card).textContent = `Appliance-ID ${pr.applianceId}` + (pr.sizeKwp ? ` · ${pr.sizeKwp} kWp` : '');
    const badge = $('.badge', card);
    const [label, cls] = STATUS[pr.status] || [pr.status, ''];
    badge.textContent = label;
    badge.classList.add(cls);
    $('.ap-waiting', card).hidden = pr.status !== 'waiting';
    $('.ap-requested', card).hidden = pr.status !== 'requested';
    $('.ap-live', card).hidden = pr.status !== 'approved';
    $('.ap-declined', card).hidden = pr.status !== 'declined';
    if (pr.status === 'waiting') $('strong', $('.paircode', card)).textContent = pr.code;

    const msg = (t) => flash(card, t);
    $('.copyCode', card)?.addEventListener('click', (e) => {
      navigator.clipboard?.writeText(pr.code || '');
      e.target.textContent = 'Kopiert ✓';
      setTimeout(() => { e.target.textContent = 'Kopieren'; }, 1500);
    });
    $('.accept', card)?.addEventListener('click', async () => {
      const r = await api(`/api/pairings/${pr.applianceId}/accept`, { method: 'POST' });
      if (!r.j.ok) msg(`Fehler: ${r.j.error || r.status}`); else refreshPairings();
    });
    $('.decline', card)?.addEventListener('click', async () => {
      const r = await api(`/api/pairings/${pr.applianceId}/decline`, { method: 'POST' });
      if (!r.j.ok) msg(`Fehler: ${r.j.error || r.status}`); else refreshPairings();
    });
    $('.rename', card)?.addEventListener('click', async () => {
      const name = prompt('Name der Anlage (leer = Standardname der Anlage):', pr.name || pr.applianceName || '');
      if (name === null) return;
      const customer = prompt('Kunde:', pr.customer || '');
      if (customer === null) return;
      const sizeKwp = prompt('Anlagengröße in kWp (leer = keine Angabe):', pr.sizeKwp ?? '');
      if (sizeKwp === null) return;
      const r = await api(`/api/pairings/${pr.applianceId}/rename`, { method: 'POST', body: { name, customer, sizeKwp } });
      if (!r.j.ok) msg(`Fehler: ${r.j.error || r.status}`); else refreshPairings();
    });
    $('.remove', card).addEventListener('click', async () => {
      if (!confirm(`Kopplung von ${pr.applianceId} entfernen?`)) return;
      await api(`/api/pairings/${pr.applianceId}`, { method: 'DELETE' });
      refreshPairings();
    });

    if (pr.status === 'approved') {
      const s = pr.lastStatus || {};
      $('.soc', card).textContent = fmtPct(s.soc);
      $('.bat', card).textContent = fmtW(s.batteryPowerW);
      $('.pv', card).textContent = fmtW(s.pvTotalW);
      $('.grid', card).textContent = fmtW(s.gridSetpointW);
      $('.minsoc', card).textContent = fmtPct(s.minSocPct);
      const alarmP = $('.alarms', card);
      const n = Number(s.alarmsActive) || 0;
      // „Veraltet“ unabhängig von der Anzahl zeigen — 0 Alarme bei stehender
      // Alarm-Abfrage heißt nicht „alles gut“.
      const parts = [];
      if (n) parts.push(`⚠ ${n} aktive Alarme (Schweregrad ${s.alarmsSeverity ?? '?'})`);
      if (s.alarmsStale) parts.push('⚠ Alarm-Überwachung liefert keine aktuellen Daten');
      alarmP.hidden = parts.length === 0;
      alarmP.textContent = parts.join(' · ');
      const flags = [];
      if (s.emergencyStop) flags.push('🛑 Not-Halt aktiv');
      if (s.telemetryFrozen) flags.push('❄ Telemetrie eingefroren');
      if (s.supportTunnelOpen) flags.push('🔓 Support-Tunnel offen');
      if (s.version) flags.push(`Stand ${s.version}`);
      $('.flags', card).textContent = flags.join('  ·  ');
      $('.seen', card).textContent = `Zuletzt gehört: ${fmtAge(pr.seenAt)}`;

      const queueCmd = async (type, args) => {
        const r = await api(`/api/pairings/${pr.applianceId}/command`, { method: 'POST', body: { type, args } });
        if (!r.j.ok) return msg(`Kommando-Fehler: ${r.j.error || r.status}`);
        msg('Kommando eingereiht — die Anlage holt es beim nächsten Poll ab (≤ 30 s)…');
      };
      $('.tunnelOpen', card).addEventListener('click', async () => {
        const ttl = prompt('Tunnel-Öffnungsdauer in Minuten (5–240):', '60');
        if (ttl == null) return;
        await queueCmd('open_tunnel', { ttlMin: Number(ttl) || 60 });
      });
      $('.tunnelClose', card).addEventListener('click', () => queueCmd('close_tunnel'));
      $('.loadUpdates', card).addEventListener('click', async () => {
        await queueCmd('updates_check');
        // Ergebnis erscheint, sobald die Anlage es geliefert hat.
        setTimeout(refreshPairings, 35000);
      });
      const pre = $('.ap-detail', card);
      const done = Object.values(pr.results || {});
      if (done.length) {
        pre.hidden = false;
        pre.textContent = done.map((r) => `${r.at} · ${r.ok ? 'OK' : 'FEHLER'}:\n${JSON.stringify(r.result, null, 2)}`).join('\n\n');
      }
    }
    list.appendChild(node);
  }
  if (!pairings.length) {
    const p = document.createElement('p');
    p.className = 'sub empty';
    p.textContent = 'Noch keine Anlage gekoppelt.';
    list.appendChild(p);
  }
}

function flash(card, text) {
  const el = $('.ap-msg', card);
  if (el) { el.textContent = text; setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 8000); }
}

setView();
// Sessioncheck beim Start: wenn Cookie abgelaufen, liefert /api/me 401 → zurück zu Login
async function refreshMe() {
  const { status, j } = await api('/api/me');
  if (status === 401) { localStorage.removeItem('dvportal-name'); setView(); return; }
  isAdminUser = j.role === 'admin';
  renderSecurity(j);
}
(async () => {
  // Frisches Portal? Import-Hinweis auf der Login-Karte zeigen.
  try {
    const info = await (await fetch('/api/portal-info')).json();
    const hint = $('#firstRunImport');
    if (hint) hint.hidden = !!info.hasAccounts;
  } catch { /* egal */ }
  if (localStorage.getItem('dvportal-name')) {
    await refreshMe();
    setView();
  }
})();

// ── Sicherheit-Kachel: TOTP einrichten, Passkeys verwalten ─────────────
function renderSecurity(me) {
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (label, cls, fn) => { const b = mk('button', 'btn ' + (cls || ''), label); b.type = 'button'; b.addEventListener('click', fn); return b; };

  // ── TOTP ──
  const totpBox = $('#totpBox');
  if (totpBox) {
    totpBox.replaceChildren();
    totpBox.appendChild(mk('b', null, 'Zwei-Faktor (Authenticator-App)'));
    if (me.totpEnabled) {
      totpBox.appendChild(mk('span', 'badge ok', 'aktiv'));
      const code = document.createElement('input');
      code.placeholder = 'Code zum Deaktivieren'; code.inputMode = 'numeric'; code.maxLength = 6; code.style.maxWidth = '180px';
      totpBox.appendChild(document.createElement('br'));
      totpBox.appendChild(code);
      totpBox.appendChild(btn('Deaktivieren', '', async () => {
        const r = await api('/api/totp/disable', { method: 'POST', body: { code: code.value.trim() } });
        if (!r.j.ok) alert(r.j.error === 'code_falsch' ? 'Code falsch.' : `Fehler: ${r.j.error}`);
        else renderSecurity(await (await api('/api/me')).j);
      }));
    } else {
      totpBox.appendChild(mk('span', 'badge warn', 'aus'));
      totpBox.appendChild(btn('Einrichten', 'primary', async () => {
        const { j } = await api('/api/totp/setup', { method: 'POST' });
        if (!j.ok) return alert(`Fehler: ${j.error}`);
        totpBox.replaceChildren();
        totpBox.appendChild(mk('b', null, '1 · Secret in der App anlegen'));
        totpBox.appendChild(document.createElement('br'));
        const secretEl = mk('code', 'totpsecret', j.secret);
        totpBox.appendChild(secretEl);
        totpBox.appendChild(btn('Kopieren', 'tiny', () => navigator.clipboard?.writeText(j.secret)));
        totpBox.appendChild(mk('div', 'admin-sub', `oder manuell: ${j.otpauth}`));
        totpBox.appendChild(document.createElement('br'));
        const code = document.createElement('input');
        code.placeholder = 'Dann Code bestätigen'; code.inputMode = 'numeric'; code.maxLength = 6;
        totpBox.appendChild(code);
        totpBox.appendChild(btn('Aktivieren', 'primary', async () => {
          const r = await api('/api/totp/enable', { method: 'POST', body: { code: code.value.trim() } });
          if (!r.j.ok) alert(r.j.error === 'code_falsch' ? 'Code falsch — neu versuchen.' : `Fehler: ${r.j.error}`);
          else renderSecurity(await (await api('/api/me')).j);
        }));
      }));
    }
  }

  // ── Passkeys ──
  const pkBox = $('#passkeyBox');
  if (pkBox) {
    pkBox.replaceChildren();
    pkBox.appendChild(mk('b', null, 'Passkeys (Touch-ID, Windows Hello, Security-Key)'));
    const list = (me.passkeys || []);
    if (!list.length) pkBox.appendChild(mk('div', 'admin-sub', 'Noch kein Passkey — anmelden geht weiter mit Passwort' + (me.totpEnabled ? ' + 2FA' : '') + '.'));
    for (const k of list) {
      const row = mk('div', 'admin-ap');
      row.appendChild(mk('span', null, `🔑 ${k.label}${k.lastUsed ? ` · zuletzt ${new Date(k.lastUsed).toLocaleString('de-DE')}` : ''}`));
      row.appendChild(btn('Entfernen', 'tiny', async () => {
        if (!confirm(`Passkey „${k.label}“ entfernen?`)) return;
        await api(`/api/passkeys/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
        renderSecurity(await (await api('/api/me')).j);
      }));
      pkBox.appendChild(row);
    }
    pkBox.appendChild(btn('➕ Passkey hinzufügen', 'primary', async () => {
      try {
        const { j } = await api('/api/passkey/register-begin', { method: 'POST' });
        if (!j.ok) return alert(`Fehler: ${j.error}`);
        const label = prompt('Name für den Passkey (z. B. „MacBook Touch-ID“):', '') || 'Passkey';
        const cred = await navigator.credentials.create({ publicKey: {
          challenge: b64ToBuf(j.challenge),
          rp: { name: 'DVhub Installateurs-Portal', id: j.rpId },
          user: { id: new TextEncoder().encode(j.userId || 'user'), name: me.name, displayName: me.name },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
          timeout: 60000, attestation: 'none',
        } });
        const r = await api('/api/passkey/register-finish', { method: 'POST', body: {
          label,
          attestationObject: bufToB64(cred.response.attestationObject),
          clientDataJSON: bufToB64(cred.response.clientDataJSON),
        } });
        if (!r.j.ok) alert(`Registrierung abgelehnt: ${r.j.error || r.status}`);
        else renderSecurity(await (await api('/api/me')).j);
      } catch (e) {
        if (e.name !== 'NotAllowedError') alert(`Passkey-Fehler: ${e.message}`);
      }
    }));
  }
}

// ── Admin: Übersicht, Umverteilung, Backup ──────────────────────────
const ADMIN_STATUS_LABEL = { waiting: 'wartet', requested: 'Anfrage', approved: 'live', declined: 'abgelehnt' };

async function refreshAdmin() {
  const { status, j } = await api('/api/admin/overview');
  const box = $('#adminOverview');
  if (status === 403) { $('#adminMsg').textContent = 'Nur für Admin-Konten (ADMIN_ACCOUNTS).'; box.replaceChildren(); return; }
  if (!j.ok) return;
  box.replaceChildren();
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const table = mk('table', 'admin-table');
  const thead = mk('thead');
  const hr = mk('tr');
  for (const h of ['Installateur', 'Anlagen', 'live', 'kWp gesamt', 'Anlagen im Detail']) hr.appendChild(mk('th', null, h));
  thead.appendChild(hr); table.appendChild(thead);
  const tbody = mk('tbody');
  for (const ins of j.installers) {
    const tr = mk('tr');
    const nameTd = mk('td');
    nameTd.appendChild(mk('div', 'admin-name', ins.name));
    if (ins.company) nameTd.appendChild(mk('div', 'admin-sub', ins.company));
    if (ins.role === 'admin') nameTd.appendChild(mk('span', 'badge teal', 'Admin'));
    tr.appendChild(nameTd);
    tr.appendChild(mk('td', 'admin-num', String(ins.counts.total)));
    tr.appendChild(mk('td', 'admin-num', String(ins.counts.live)));
    tr.appendChild(mk('td', 'admin-num', ins.totalKwp ? `${ins.totalKwp}` : '–'));
    const det = mk('td', 'admin-det');
    if (!ins.appliances.length) det.appendChild(mk('span', 'admin-sub', '—'));
    for (const ap of ins.appliances) {
      const row = mk('div', 'admin-ap');
      row.appendChild(mk('span', null, `${ap.name || ap.applianceId}${ap.customer ? ' · ' + ap.customer : ''}`));
      row.appendChild(mk('span', `badge ${ap.status === 'approved' ? 'ok' : 'warn'}`, ADMIN_STATUS_LABEL[ap.status] || ap.status));
      if (ap.sizeKwp) row.appendChild(mk('span', 'admin-sub', `${ap.sizeKwp} kWp`));
      // Umverteilen
      const others = j.installers.filter((x) => x.key !== ins.key);
      if (others.length) {
        const sel = document.createElement('select');
        for (const o of others) {
          const opt = document.createElement('option');
          opt.value = o.key; opt.textContent = o.name;
          sel.appendChild(opt);
        }
        const btn = mk('button', 'btn tiny', 'Umverteilen');
        btn.type = 'button';
        btn.addEventListener('click', async () => {
          if (!confirm(`Anlage „${ap.name || ap.applianceId}“ zu ${others.find((o) => o.key === sel.value)?.name} verschieben?`)) return;
          const r = await api('/api/admin/reassign', { method: 'POST', body: { applianceId: ap.applianceId, toAccount: sel.value } });
          const m = $('#adminMsg');
          m.textContent = r.j.ok ? '✓ Umverteilt.' : `Fehler: ${r.j.error || r.status}`;
          if (r.j.ok) refreshAdmin();
        });
        row.appendChild(sel); row.appendChild(btn);
      }
      det.appendChild(row);
    }
    tr.appendChild(det);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  box.appendChild(table);
}

$('#exportBtn')?.addEventListener('click', async () => {
  const res = await fetch('/api/admin/export', { credentials: 'same-origin' });
  if (!res.ok) { $('#backupMsg').textContent = 'Export fehlgeschlagen.'; return; }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `dvhub-portal-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  $('#backupMsg').textContent = '✓ Backup heruntergeladen — Private Keys enthalten, sicher aufbewahren!';
});

async function doImport(inputEl) {
  const f = inputEl.files?.[0];
  if (!f) return;
  // Auf der Anmeldeseite (frisches Portal) ist #backupMsg im versteckten
  // Admin-Bereich — die Meldung muss dort landen, wo der Nutzer gerade ist.
  const msgEl = inputEl.id === 'importFileFresh' ? $('#authMsg') : $('#backupMsg');
  try {
    const text = await f.text();
    const body = JSON.parse(text);
    if (inputEl.id === 'importFileFresh') body.setupToken = $('#authSetupToken').value || undefined;
    const { status, j } = await api('/api/admin/import', { method: 'POST', body });
    if (msgEl) msgEl.textContent = j.ok
      ? `✓ Importiert: ${j.accounts} Konten. Seite neu laden.`
      : `Import-Fehler: ${{ setup_token_noetig: 'Auf einem frischen Portal braucht der Import das Admin-Setup-Token (Feld oben).' }[j.error] || j.error || status}`;
    if (j.ok) setTimeout(() => location.reload(), 1200);
  } catch (e) {
    if (msgEl) msgEl.textContent = `Import-Fehler: ${e.message}`;
  } finally { inputEl.value = ''; }
}
$('#importFile')?.addEventListener('change', (e) => doImport(e.target));
$('#importFileFresh')?.addEventListener('change', (e) => doImport(e.target));
