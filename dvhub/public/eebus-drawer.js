// eebus-drawer.js -- Integrationen → EEBUS (§14a-Steuerbox, EEBUS-Geräte).
// Status des Dienstes, eigene SKI, Kopplung (mDNS-Liste, Kopplungsanfragen,
// SKI von Hand), gekoppelte Gegenstellen und der §14a-Zustand.
// Geöffnet von integrations.js (openDrawerForSystem('eebus')).
(function () {
  'use strict';

  let pollTimer = null;
  let last = null;

  const STATUS = {
    disabled: 'aus — in den Einstellungen (System → EEBUS) aktivieren',
    not_installed: 'nicht installiert — beim nächsten Update wird dvhub-eebus gebaut',
    starting: 'startet …',
    running: 'läuft',
    restarting: 'startet neu …',
    error: 'Fehler',
    stopped: 'gestoppt',
  };
  const GRID_STATE = {
    disabled: 'keine Steuerbox gekoppelt',
    init: 'Start — wartet auf die Steuerbox',
    unlimited_controlled: 'frei (Steuerbox verbunden)',
    limited: 'begrenzt',
    failsafe: 'Failsafe — Verbindung zur Steuerbox fehlt',
    unlimited_autonomous: 'frei (Steuerbox weiter nicht erreichbar)',
  };
  const OHPCF = {
    announced: 'angekündigt', scheduled: 'eingeplant', running: 'läuft', paused: 'pausiert',
    stopped: 'abgebrochen', completed: 'fertig',
  };

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function apiFetch(path, opts) {
    const common = window.DVhubCommon;
    if (common && typeof common.apiFetch === 'function') return common.apiFetch(path, opts);
    return fetch(path, opts);
  }
  async function json(res) { try { return await res.json(); } catch (_) { return {}; } }
  function toast(text) {
    const t = el('dv-drawer-eebus-toast');
    if (!t) return;
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, 4000);
  }

  function fmtSki(ski) { return ski ? String(ski).replace(/(.{4})/g, '$1 ').trim() : '—'; }
  function fmtW(w) {
    if (w == null || !Number.isFinite(Number(w))) return '—';
    const n = Number(w);
    return Math.abs(n) >= 1000 ? (n / 1000).toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' kW' : Math.round(n) + ' W';
  }
  function fmtTime(ms) {
    if (!ms) return '—';
    return new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function fmtDur(s) {
    if (!s) return '—';
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return h ? h + ' h' + (m ? ' ' + m + ' min' : '') : m + ' min';
  }

  function roleSelect(name, suggested) {
    return '<select class="input eebus-role" data-name="' + esc(name) + '">'
      + '<option value="device"' + (suggested !== 'grid' ? ' selected' : '') + '>Gerät (Wärmepumpe, Wallbox …)</option>'
      + '<option value="grid"' + (suggested === 'grid' ? ' selected' : '') + '>Steuerbox (Netzbetreiber, §14a)</option>'
      + '</select>';
  }

  function gridBlock(kind, label, g) {
    if (!g) return '';
    let html = '<div class="eebus-grid-row"><strong>' + esc(label) + ':</strong> ' + esc(GRID_STATE[g.state] || g.state);
    if (g.limitW != null) html += ' — <strong>' + esc(fmtW(g.limitW)) + '</strong>';
    if (g.until) html += ' bis ' + esc(fmtTime(g.until));
    html += '</div><div class="muted eebus-small">Failsafe: ' + esc(fmtW(g.failsafeW)) + ' für mindestens '
      + esc(fmtDur(g.failsafeDurationS)) + ' · Heartbeat: ' + (g.heartbeatOk ? 'ok' : 'fehlt') + '</div>';
    return html;
  }

  function render(st) {
    last = st;
    const box = el('eebus-content');
    if (!box) return;
    let html = '';

    html += '<section class="eebus-sec"><h3>Dienst</h3>'
      + '<div><strong>Status:</strong> ' + esc(STATUS[st.status] || st.status) + '</div>';
    if (st.error) html += '<div class="eebus-error">' + esc(st.error) + '</div>';
    if (st.ski) {
      html += '<div><strong>Eigene SKI:</strong> <code class="eebus-ski">' + esc(fmtSki(st.ski)) + '</code>'
        + ' <button type="button" class="btn sm ghost" data-copy="' + esc(st.ski) + '">Kopieren</button></div>'
        + '<div class="muted eebus-small">SHIP-ID ' + esc(st.shipId || '—') + ' · Port ' + esc(st.port || '—') + '</div>';
      if (st.qr) {
        html += '<details><summary>Kopplungs-Text (für Geräte mit QR-Scan)</summary><code class="eebus-qr">' + esc(st.qr) + '</code></details>';
      }
    }
    html += '</section>';

    if (st.status === 'running') {
      // Kopplung
      const p = st.pairing || {};
      const rest = p.on && p.until ? Math.max(0, Math.round((p.until - Date.now()) / 60000)) : 0;
      html += '<section class="eebus-sec"><h3>Kopplung</h3>'
        + '<p class="muted eebus-small">Gegenstelle in DVhub vertrauen <em>und</em> DVhubs SKI in der Gegenstelle eintragen'
        + ' (Steuerbox: über den Netzbetreiber bzw. Messstellenbetreiber). Erst dann verbinden sich beide.</p>'
        + '<button type="button" class="btn sm" id="eebus-pairing">'
        + (p.on ? 'Kopplungsanfragen annehmen: an (' + rest + ' min) — ausschalten' : 'Kopplungsanfragen 10 min annehmen') + '</button>';

      const incoming = (st.waiting || []).map(function (w) {
        return '<li><code>' + esc(fmtSki(w.ski)) + '</code> ' + esc(w.shipId || '')
          + ' ' + roleSelect(w.ski, 'device') + ' <button type="button" class="btn sm" data-trust="' + esc(w.ski) + '" data-label="' + esc(w.shipId || '') + '">Vertrauen</button></li>';
      }).join('');
      if (incoming) html += '<h4>Kopplungsanfragen</h4><ul class="eebus-list">' + incoming + '</ul>';

      const found = (st.discovered || []).map(function (d) {
        const name = [d.brand, d.model].filter(Boolean).join(' ') || d.name || d.host || '?';
        return '<li><strong>' + esc(name) + '</strong> <span class="muted">' + esc(d.type || '') + '</span><br>'
          + '<code>' + esc(fmtSki(d.ski)) + '</code> ' + roleSelect(d.ski, d.suggestedRole)
          + ' <button type="button" class="btn sm" data-trust="' + esc(d.ski) + '" data-label="' + esc(name) + '">Vertrauen</button></li>';
      }).join('');
      html += '<h4>Im Netz gefunden (mDNS)</h4>'
        + (found ? '<ul class="eebus-list">' + found + '</ul>' : '<p class="muted eebus-small">Keine weiteren EEBUS-Geräte gefunden.</p>');

      html += '<h4>SKI von Hand</h4><div class="eebus-manual">'
        + '<input type="text" class="input" id="eebus-manual-ski" placeholder="40 Hex-Zeichen" maxlength="60" spellcheck="false">'
        + '<input type="text" class="input" id="eebus-manual-name" placeholder="Name" maxlength="80">'
        + roleSelect('manual', 'grid')
        + '<button type="button" class="btn sm" id="eebus-manual-add">Vertrauen</button></div>'
        + '</section>';
    }

    // Gekoppelte Gegenstellen
    const trusted = st.trusted || [];
    html += '<section class="eebus-sec"><h3>Gekoppelt</h3>';
    if (!trusted.length) html += '<p class="muted eebus-small">Noch nichts gekoppelt.</p>';
    else {
      html += '<ul class="eebus-list">' + trusted.map(function (t) {
        let line = '<li><span class="dot ' + (t.connected ? 'dot-ok' : 'dot-off') + '"></span> <strong>'
          + esc(t.name || (t.role === 'grid' ? 'Steuerbox' : 'Gerät')) + '</strong> <span class="muted">'
          + (t.role === 'grid' ? 'Steuerbox' : 'Gerät') + ' · ' + (t.connected ? 'verbunden' : 'nicht verbunden') + '</span><br>'
          + '<code>' + esc(fmtSki(t.ski)) + '</code>';
        const d = t.device;
        if (d) {
          const bits = [];
          if (d.powerW != null) bits.push('Leistung ' + fmtW(d.powerW));
          if (d.nominalW != null) bits.push('Nenn ' + fmtW(d.nominalW));
          if (d.limit) bits.push('Grenze ' + (d.limit.active ? fmtW(d.limit.w) : 'aus'));
          if (d.ohpcf && d.ohpcf.state) bits.push('Verdichter: ' + (OHPCF[d.ohpcf.state] || d.ohpcf.state));
          if (bits.length) line += '<div class="muted eebus-small">' + esc(bits.join(' · ')) + '</div>';
        }
        line += ' <button type="button" class="btn sm ghost" data-untrust="' + esc(t.ski) + '">Entkoppeln</button></li>';
        return line;
      }).join('') + '</ul>';
    }
    html += '</section>';

    // §14a
    if (st.grid && st.grid.hasGridPeer) {
      const a = st.applied || {};
      html += '<section class="eebus-sec"><h3>§14a — Grenzen der Steuerbox</h3>'
        + gridBlock('lpc', 'Bezug (LPC)', st.grid.lpc)
        + gridBlock('lpp', 'Einspeisung (LPP)', st.grid.lpp)
        + '<h4>Umsetzung</h4><ul class="eebus-list eebus-small">'
        + '<li>Bezugsgrenze: ' + esc(a.consumptionLimitW != null ? fmtW(a.consumptionLimitW) + ' — Akku lädt nicht aus dem Netz' : 'keine') + '</li>'
        + '<li>Wallbox: ' + esc(a.wallboxCapW != null ? 'höchstens ' + fmtW(a.wallboxCapW) : 'frei') + '</li>'
        + '<li>Einspeisung: ' + esc(a.productionBlock ? 'gesperrt (kein Einspeisebegrenzer)' : (a.productionLimitW != null ? 'höchstens ' + fmtW(a.productionLimitW) : 'frei')) + '</li>'
        + '</ul></section>';
    }

    if (st.energy) {
      html += '<p class="muted eebus-small">Zählerstände für die Steuerbox (seit Aktivierung): Bezug '
        + esc(fmtW(st.energy.importWh).replace('W', 'Wh')) + ' · Einspeisung ' + esc(fmtW(st.energy.exportWh).replace('W', 'Wh')) + '</p>';
    }
    box.innerHTML = html;
  }

  async function load() {
    try {
      const res = await apiFetch('/api/eebus/status');
      const st = await json(res);
      if (!res.ok) throw new Error(st.error || ('HTTP ' + res.status));
      render(st);
    } catch (e) {
      const box = el('eebus-content');
      if (box) box.innerHTML = '<p class="eebus-error">EEBUS-Status nicht abrufbar: ' + esc(e.message) + '</p>';
    }
    clearTimeout(pollTimer);
    const drawer = el('dv-drawer-eebus');
    if (drawer && !drawer.hidden) pollTimer = setTimeout(load, 5000);
  }

  async function post(path, body, method) {
    const res = await apiFetch(path, {
      method: method || 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await json(res);
    if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  async function trust(ski, name, role) {
    try {
      await post('/api/eebus/trust', { ski: ski, name: name, role: role });
      toast(role === 'grid' ? 'Steuerbox gekoppelt — DVhubs SKI muss auch in der Steuerbox eingetragen sein.' : 'Gerät gekoppelt.');
    } catch (e) {
      toast(e.message === 'grid_peer_exists' ? 'Es ist schon eine Steuerbox gekoppelt.' : 'Koppeln fehlgeschlagen: ' + e.message);
    }
    load();
  }

  document.addEventListener('click', async function (e) {
    if (!e.target.closest('#dv-drawer-eebus')) return;
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      try { await navigator.clipboard.writeText(copy.getAttribute('data-copy')); toast('SKI kopiert.'); } catch (_) { toast('Kopieren nicht möglich.'); }
      return;
    }
    if (e.target.closest('#eebus-pairing')) {
      try { await post('/api/eebus/pairing', { on: !(last && last.pairing && last.pairing.on) }); } catch (err) { toast(err.message); }
      load();
      return;
    }
    const tr = e.target.closest('[data-trust]');
    if (tr) {
      const ski = tr.getAttribute('data-trust');
      const sel = document.querySelector('#dv-drawer-eebus .eebus-role[data-name="' + ski + '"]');
      trust(ski, tr.getAttribute('data-label') || '', sel ? sel.value : 'device');
      return;
    }
    if (e.target.closest('#eebus-manual-add')) {
      const ski = String(el('eebus-manual-ski').value || '').toLowerCase().replace(/[\s:]/g, '');
      if (!/^[0-9a-f]{40}$/.test(ski)) { toast('Die SKI hat 40 Hex-Zeichen.'); return; }
      const sel = document.querySelector('#dv-drawer-eebus .eebus-role[data-name="manual"]');
      trust(ski, el('eebus-manual-name').value || '', sel ? sel.value : 'grid');
      return;
    }
    const un = e.target.closest('[data-untrust]');
    if (un) {
      if (!window.confirm('Gegenstelle entkoppeln? Sie kann danach keine Grenzen mehr setzen bzw. wird nicht mehr gesteuert.')) return;
      try { await post('/api/eebus/trust?ski=' + encodeURIComponent(un.getAttribute('data-untrust')), null, 'DELETE'); toast('Entkoppelt.'); } catch (err) { toast(err.message); }
      load();
    }
  });

  window.DVhubEebus = { load: load };
})();
