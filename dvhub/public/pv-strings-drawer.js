// pv-strings-drawer.js -- Integrationen → PV-Strings (Solar-Logger).
// Konfiguration der String-Quellen (Victron-Tracker aus VRM), Nachladen der
// Historie, Uebersicht und CSV-Download fuer die pvnode-Kalibrierung.
// Geoeffnet von integrations.js (openDrawerForSystem('pvstrings')).
(function () {
  'use strict';

  var trackers = [];   // aus /api/pv-strings/discover
  var rows = [];       // Bearbeitungsstand der Quellen
  var pollTimer = null;

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function apiFetch(path, opts) {
    var common = window.DVhubCommon;
    if (common && typeof common.apiFetch === 'function') return common.apiFetch(path, opts);
    return fetch(path, opts);
  }
  async function json(res) { try { return await res.json(); } catch (_) { return {}; } }

  function banner(id, text, kind) {
    var b = el(id);
    if (!b) return;
    b.hidden = !text;
    b.textContent = text || '';
    b.classList.toggle('is-error', kind === 'error');
    b.classList.toggle('is-ok', kind === 'ok');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function slug(label) {
    var s = String(label || '').toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    return s || 'string';
  }

  function trackerLabel(t) {
    return 'Laderegler ' + t.instance + ' · Tracker ' + (t.tracker + 1) + (t.name ? ' „' + t.name + '“' : '');
  }

  function trackerOptions(row) {
    var list = trackers.slice();
    var has = list.some(function (t) { return t.instance === row.instance && t.tracker === row.tracker; });
    if (!has) list.push({ instance: row.instance, tracker: row.tracker, name: null });
    return list.map(function (t) {
      var v = t.instance + ':' + t.tracker;
      var sel = (t.instance === row.instance && t.tracker === row.tracker) ? ' selected' : '';
      return '<option value="' + v + '"' + sel + '>' + esc(trackerLabel(t)) + '</option>';
    }).join('');
  }

  function renderRows() {
    var host = el('pvs-rows');
    if (!host) return;
    if (!rows.length) {
      host.innerHTML = '<p class="field-hint">Noch keine Strings. &bdquo;Tracker aus VRM holen&ldquo; schl&auml;gt sie vor.</p>';
      return;
    }
    host.innerHTML = rows.map(function (r, i) {
      return '<div class="pvs-row" data-i="' + i + '">'
        + '<input type="text" class="input pvs-label" value="' + esc(r.label) + '" placeholder="Name, z. B. Süd A" aria-label="Name">'
        + '<select class="input pvs-tracker" aria-label="Tracker">' + trackerOptions(r) + '</select>'
        + '<input type="number" class="input pvs-kwp" min="0" step="0.1" value="' + (r.kwp != null ? esc(r.kwp) : '') + '" placeholder="kWp" aria-label="kWp">'
        + '<button type="button" class="btn sm ghost pvs-remove" aria-label="Entfernen">&times;</button>'
        + '</div>';
    }).join('');
  }

  function readRows() {
    var host = el('pvs-rows');
    if (!host) return;
    host.querySelectorAll('.pvs-row').forEach(function (node) {
      var r = rows[Number(node.getAttribute('data-i'))];
      if (!r) return;
      r.label = node.querySelector('.pvs-label').value.trim();
      var t = node.querySelector('.pvs-tracker').value.split(':');
      r.instance = Number(t[0]);
      r.tracker = Number(t[1]);
      var k = node.querySelector('.pvs-kwp').value;
      r.kwp = k === '' ? null : Number(k);
    });
  }

  function renderOverview(data) {
    var host = el('pvs-overview');
    if (!host) return;
    var src = Array.isArray(data.sources) ? data.sources : [];
    if (!src.length) { host.innerHTML = ''; return; }
    host.innerHTML = src.map(function (s) {
      var days = (s.dailyKwh || []).slice(-7);
      var max = days.reduce(function (m, d) { return Math.max(m, d.kwh); }, 0) || 1;
      // SVG statt Inline-Styles (CSP style-src ohne 'unsafe-inline').
      var bars = '<svg class="pvs-svg" viewBox="0 0 ' + (days.length * 12) + ' 30" preserveAspectRatio="none" role="img">'
        + days.map(function (d, i) {
          var h = Math.max(1, Math.round((d.kwh / max) * 28));
          return '<rect x="' + (i * 12 + 1) + '" y="' + (30 - h) + '" width="10" height="' + h + '"><title>'
            + esc(d.day + ': ' + d.kwh.toFixed(1) + ' kWh') + '</title></rect>';
        }).join('') + '</svg>';
      var last = days.length ? days[days.length - 1] : null;
      var enough = s.coverageDays >= 90;
      return '<div class="pvs-card">'
        + '<div class="pvs-card-head"><strong>' + esc(s.label) + '</strong>'
        + '<span class="pvs-meta">' + (s.kwp ? esc(s.kwp) + ' kWp · ' : '') + 'Tracker ' + (s.tracker + 1) + '</span></div>'
        + '<div class="pvs-card-body">'
        + '<div class="pvs-cover">' + (s.slots ? (fmtDate(s.firstTs) + ' – ' + fmtDate(s.lastTs) + ' · ' + s.coverageDays + ' Tage') : 'noch keine Daten')
        + (s.slots && !enough ? ' <span class="pvs-warn">(pvnode braucht ≥ 90 Tage)</span>' : '') + '</div>'
        + '<div class="pvs-bars" aria-label="Tagesertrag letzte 7 Tage">' + bars + '</div>'
        + (last ? '<div class="pvs-meta">' + esc(last.day) + ': ' + last.kwh.toFixed(1) + ' kWh</div>' : '')
        + '</div>'
        + '<button type="button" class="btn sm pvs-csv" data-id="' + esc(s.id) + '"' + (s.slots ? '' : ' disabled') + '>CSV für pvnode</button>'
        + '</div>';
    }).join('');
  }

  function renderStatus(st) {
    var b = st && st.backfill ? st.backfill : {};
    var parts = [];
    if (b.running) parts.push('Nachladen läuft: ' + b.doneDays + ' / ' + b.totalDays + ' Tage');
    else if (b.finishedAt) parts.push('Nachladen fertig: ' + b.doneDays + ' Tage' + (b.error ? ' — Fehler: ' + b.error : ''));
    if (st && st.lastSyncAt) parts.push('Letzte Erfassung: ' + new Date(st.lastSyncAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }));
    if (st && st.lastError) parts.push('Fehler: ' + st.lastError);
    banner('pvs-status', parts.join(' · '), (st && (st.lastError || b.error)) ? 'error' : null);
    var btn = el('pvs-backfill');
    if (btn) btn.disabled = !!b.running;
    clearTimeout(pollTimer);
    if (b.running) pollTimer = setTimeout(load, 5000);
  }

  async function load() {
    try {
      var res = await apiFetch('/api/pv-strings');
      var data = await json(res);
      if (!res.ok || !data.ok) { banner('pvs-banner', data.error || ('HTTP ' + res.status), 'error'); return; }
      if (el('pvs-enabled')) el('pvs-enabled').checked = !!data.enabled;
      if (!rows.length || !document.activeElement || !el('pvs-rows').contains(document.activeElement)) {
        rows = (data.sources || []).map(function (s) {
          return { id: s.id, label: s.label, instance: s.instance, tracker: s.tracker, kwp: s.kwp };
        });
        renderRows();
      }
      if (!data.vrmConfigured) banner('pvs-banner', 'VRM-Zugang fehlt — erst unter „VRM Cloud“ Portal-ID und Token eintragen.', 'error');
      renderOverview(data);
      renderStatus(data.status);
    } catch (e) {
      banner('pvs-banner', e.message, 'error');
    }
  }

  async function discover() {
    readRows();
    banner('pvs-banner', 'Frage VRM nach den Trackern …');
    var res = await apiFetch('/api/pv-strings/discover');
    var data = await json(res);
    if (!res.ok || !data.ok) { banner('pvs-banner', data.error || ('HTTP ' + res.status), 'error'); return; }
    trackers = data.trackers || [];
    var added = 0;
    trackers.forEach(function (t) {
      if (t.enabled === false) return;
      var exists = rows.some(function (r) { return r.instance === t.instance && r.tracker === t.tracker; });
      if (exists) return;
      rows.push({ id: null, label: t.name || ('Tracker ' + (t.tracker + 1)), instance: t.instance, tracker: t.tracker, kwp: null });
      added += 1;
    });
    renderRows();
    banner('pvs-banner', trackers.length + ' Tracker gefunden' + (added ? ', ' + added + ' vorgeschlagen — Namen anpassen und speichern.' : '.'), 'ok');
  }

  async function save() {
    readRows();
    var used = {};
    var sources = rows.map(function (r) {
      var id = r.id || slug(r.label);
      var base = id; var n = 2;
      while (used[id]) { id = base.slice(0, 29) + '-' + n; n += 1; }
      used[id] = true;
      r.id = id;
      var s = { id: id, label: r.label || id, kind: 'victron_vrm_tracker', instance: r.instance, tracker: r.tracker };
      if (r.kwp > 0) s.kwp = r.kwp;
      return s;
    });
    var res = await apiFetch('/api/pv-strings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !!(el('pvs-enabled') && el('pvs-enabled').checked), sources: sources })
    });
    var data = await json(res);
    if (!res.ok || !data.ok) { banner('pvs-banner', data.error || ('HTTP ' + res.status), 'error'); return; }
    banner('pvs-banner', 'Gespeichert.', 'ok');
    load();
  }

  async function backfill() {
    var res = await apiFetch('/api/pv-strings/backfill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    var data = await json(res);
    if (!res.ok || !data.ok) { banner('pvs-status', data.error || ('HTTP ' + res.status), 'error'); return; }
    setTimeout(load, 1500);
  }

  async function downloadCsv(id) {
    var res = await apiFetch('/api/pv-strings/export.csv?id=' + encodeURIComponent(id));
    if (!res.ok) { banner('pvs-status', 'Download fehlgeschlagen: HTTP ' + res.status, 'error'); return; }
    var blob = await res.blob();
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pvnode-' + id + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  document.addEventListener('click', function (e) {
    if (e.target.closest('#pvs-discover')) { discover(); return; }
    if (e.target.closest('#pvs-save')) { save(); return; }
    if (e.target.closest('#pvs-backfill')) { backfill(); return; }
    var rm = e.target.closest('.pvs-remove');
    if (rm) {
      readRows();
      rows.splice(Number(rm.closest('.pvs-row').getAttribute('data-i')), 1);
      renderRows();
      return;
    }
    var csv = e.target.closest('.pvs-csv');
    if (csv) downloadCsv(csv.getAttribute('data-id'));
  });

  window.DVhubPvStrings = { load: load };
})();
