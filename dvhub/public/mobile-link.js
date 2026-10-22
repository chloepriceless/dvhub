// mobile-link.js — Kachel „Handy-App“ in den Einstellungen (2026-10-22).
// QR-Code zum Koppeln anzeigen, Anfrage freigeben, gekoppelte Geräte
// verwalten. Server: /api/mobile-link/* (routes-api.js).
(function () {
  const common = window.DVhubCommon || {};
  const apiFetch = common.apiFetch || ((p, o) => fetch(p, o));
  const esc = common.escapeHtml || ((v) => String(v ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;'));
  const $ = (id) => document.getElementById(id);
  let uiToken = null;
  let pollTimer = null;
  let shownQr = null;
  // QR-Bild und Freigabe-Token kommen nur aus der Antwort von pair/start
  // (nicht aus dem Status) — nach einem Neuladen muss neu gestartet werden.
  let started = null; // { qr, qrSvg, approveToken }
  let formLoaded = false;

  function setResult(text) { const el = $('mobileLinkResult'); if (el) el.textContent = text || ''; }

  async function post(path, body = {}) {
    const res = await apiFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, uiToken }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
    return j;
  }

  const ERRORS = {
    ui_token_required: 'Sicherheits-Token abgelaufen — Seite neu laden.',
    relay_url_invalid: 'Relay-Adresse ungültig (wss://… bzw. ws:// nur im eigenen Netz).',
    mobile_link_disabled: 'Erst „Handy-App erlauben“ einschalten und speichern.',
    too_many_devices: 'Es sind schon 10 Geräte gekoppelt — erst eines entfernen.',
    no_pairing_to_approve: 'Keine Anfrage mehr offen — Kopplung neu starten.',
    device_not_found: 'Gerät nicht gefunden.',
    approve_token_invalid: 'Diese Kopplung wurde in einem anderen Fenster gestartet — dort freigeben oder hier neu starten.',
    mobile_link_store_unreadable: 'Schlüsseldatei der Handy-App ist nicht lesbar — siehe Protokoll.',
  };
  const errText = (e) => ERRORS[e?.message] || e?.message || 'Fehler';

  function linkText(l, label) {
    if (!l) return null;
    if (l.online) return `${label}: verbunden`;
    return `${label}: ${l.state === 'connecting' ? 'verbindet…' : 'nicht verbunden'}${l.lastError ? ` (${l.lastError})` : ''}`;
  }

  function renderDevices(list) {
    const box = $('mobileLinkDevices');
    if (!box) return;
    if (!list.length) { box.innerHTML = '<div class="installer-portal-meta">Noch kein Handy gekoppelt.</div>'; return; }
    box.innerHTML = list.map((d) => {
      const seen = d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString('de-DE') : 'noch nie';
      const perms = d.perms.includes('control') ? 'anzeigen und steuern' : 'nur anzeigen';
      return `<div class="installer-portal-meta">`
        + `<strong>${esc(d.name)}</strong> ${d.model ? `(${esc(d.model)})` : ''} — ${perms}`
        + ` · ${d.online ? '<strong>gerade verbunden</strong>' : `zuletzt ${esc(seen)}`}`
        + ` <button class="btn btn-danger btn-small" type="button" data-mobile-remove="${esc(d.id)}">Entkoppeln</button>`
        + `</div>`;
    }).join('');
  }

  function renderPairing(p) {
    const box = $('mobileLinkPairBox');
    const qr = $('mobileLinkQr');
    const approve = $('mobileLinkApproveBox');
    const cancel = $('mobileLinkCancelBtn');
    if (!box || !qr || !approve) return;
    if (!p) {
      box.hidden = true;
      qr.innerHTML = '';
      shownQr = null;
      started = null;
      approve.hidden = true;
      if (cancel) cancel.hidden = true;
      return;
    }
    box.hidden = false;
    if (cancel) cancel.hidden = false;
    const until = new Date(p.expiresAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    if (p.status === 'waiting') {
      if (started) {
        $('mobileLinkPairHint').textContent = `Mit der DVhub-App (oder der Kamera) scannen — gültig bis ${until}, nur für ein Handy.`;
        // Das SVG kommt von der eigenen Anlage (qr.js, nur Zahlen, kein Skript).
        // Neu zeichnen, sobald sich der Inhalt ändert (erneut „Handy koppeln“ =
        // neues Geheimnis, der alte Code gilt dann nicht mehr).
        if (shownQr !== started.qr || !qr.innerHTML) { qr.innerHTML = started.qrSvg || ''; shownQr = started.qr; }
      } else {
        $('mobileLinkPairHint').textContent = 'Eine Kopplung wurde in einem anderen Fenster gestartet. Hier „Handy koppeln“ drücken, um neu zu beginnen.';
        qr.innerHTML = '';
        shownQr = null;
      }
      approve.hidden = true;
    } else if (p.status === 'consumed') {
      $('mobileLinkPairHint').textContent = 'Handy meldet sich…';
      qr.innerHTML = '';
      shownQr = null;
      approve.hidden = true;
    } else if (p.status === 'scanned' && p.candidate) {
      $('mobileLinkPairHint').textContent = `Anfrage offen bis ${until}.`;
      qr.innerHTML = '';
      shownQr = null;
      const code = String(p.candidate.code || '');
      $('mobileLinkCandidate').innerHTML = `Möchte sich koppeln: <strong>${esc(p.candidate.name || 'Handy')}</strong>`
        + (p.candidate.model ? ` (${esc(p.candidate.model)})` : '')
        + `<br>Vergleichscode: <strong class="mobile-link-code">${esc(code.slice(0, 3))} ${esc(code.slice(3))}</strong>`
        + ' — muss genau so in der App stehen. Sonst ablehnen.';
      approve.hidden = !started;
    }
  }

  async function refresh() {
    try {
      const res = await apiFetch('/api/mobile-link/status');
      if (!res.ok) return;
      const j = await res.json();
      uiToken = j.uiToken || uiToken;
      if (!formLoaded) {
        $('mobileLinkEnabled').checked = j.enabled === true;
        $('mobileLinkUseRelay').checked = j.useRelay !== false;
        $('mobileLinkRelayUrl').value = j.relayUrl === j.defaultRelayUrl ? '' : (j.relayUrl || '');
        $('mobileLinkName').value = j.name || '';
        formLoaded = true;
      }
      const parts = j.enabled
        ? [linkText(j.lan, 'Heimnetz'), j.useRelay ? (linkText(j.relay, 'Relay') || 'Relay: verbindet sich, sobald ein Handy gekoppelt ist') : 'Relay: aus']
        : ['Aus'];
      if (j.enabled && j.useRelay && !j.relayUrlValid) parts.push('Relay-Adresse ungültig');
      $('mobileLinkState').textContent = parts.filter(Boolean).join(' · ');
      $('mobileLinkPairBtn').disabled = !j.enabled;
      renderPairing(j.pairing);
      renderDevices(j.devices || []);
      schedule(j.pairing ? 2000 : 15000);
    } catch { schedule(15000); }
  }

  function schedule(ms) {
    clearTimeout(pollTimer);
    // Nur nachladen, solange die Kachel sichtbar ist.
    pollTimer = setTimeout(() => { if (!document.hidden) refresh(); else schedule(ms); }, ms);
  }

  async function save() {
    setResult('Speichere…');
    try {
      await post('/api/mobile-link/settings', {
        enabled: $('mobileLinkEnabled').checked,
        useRelay: $('mobileLinkUseRelay').checked,
        relayUrl: $('mobileLinkRelayUrl').value.trim(),
        name: $('mobileLinkName').value.trim(),
      });
      setResult('✓ Gespeichert.');
      formLoaded = false;
      refresh();
    } catch (e) { setResult('Fehler: ' + errText(e)); }
  }

  async function startPair() {
    setResult('');
    try {
      const r = await post('/api/mobile-link/pair/start', { lanHost: window.location.host });
      started = { qr: r.pairing.qr, qrSvg: r.pairing.qrSvg, approveToken: r.pairing.approveToken };
      refresh();
    } catch (e) { setResult('Fehler: ' + errText(e)); }
  }

  async function approve() {
    try {
      const perms = $('mobileLinkPerms').value === 'control' ? ['read', 'control'] : ['read'];
      const r = await post('/api/mobile-link/pair/approve', { perms, approveToken: started?.approveToken });
      started = null;
      setResult(`✓ ${r.device?.name || 'Handy'} ist gekoppelt.`);
      refresh();
    } catch (e) { setResult('Fehler: ' + errText(e)); }
  }

  async function cancel() {
    try { await post('/api/mobile-link/pair/cancel'); } catch { /* egal */ }
    started = null;
    refresh();
  }

  async function removeDevice(id) {
    const msg = 'Dieses Handy entkoppeln? Es verliert sofort den Zugriff.';
    const ok = typeof window.dvConfirm === 'function' ? await window.dvConfirm(msg) : window.confirm(msg);
    if (!ok) return;
    try { await post('/api/mobile-link/devices/remove', { id }); setResult('✓ Entkoppelt.'); } catch (e) { setResult('Fehler: ' + errText(e)); }
    refresh();
  }

  function init() {
    if (!$('mobileLinkPairBtn')) return;
    $('mobileLinkSaveBtn').addEventListener('click', save);
    $('mobileLinkPairBtn').addEventListener('click', startPair);
    $('mobileLinkCancelBtn').addEventListener('click', cancel);
    $('mobileLinkApproveBtn').addEventListener('click', approve);
    $('mobileLinkDenyBtn').addEventListener('click', cancel);
    $('mobileLinkDevices').addEventListener('click', (ev) => {
      const id = ev.target?.getAttribute?.('data-mobile-remove');
      if (id) removeDevice(id);
    });
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
