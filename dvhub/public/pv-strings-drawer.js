// pv-strings-drawer.js -- Integrationen → PV-Strings (Solar-Logger).
// Konfiguration der String-Quellen (Victron-Tracker aus VRM, Fronius-MPPTs),
// Gruppen (Summe mehrerer Strings), Nachladen der Historie, Uebersicht und
// CSV-Download fuer die pvnode-Kalibrierung.
// Geoeffnet von integrations.js (openDrawerForSystem('pvstrings')).
(function () {
  'use strict';

  var trackers = [];   // aus /api/pv-strings/discover
  var mppts = [];      // aus /api/pv-strings/discover-fronius
  var rows = [];       // Bearbeitungsstand der Quellen
  var groups = [];     // Bearbeitungsstand der Gruppen
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

  // Eine Quelle als Schluessel fuer das Auswahlfeld:
  // "vrm:<instance>:<tracker>" oder "fronius:<host>:<mppt>".
  function sourceKey(r) {
    return r.kind === 'fronius_mppt' ? 'fronius:' + r.host + ':' + r.mppt : 'vrm:' + r.instance + ':' + r.tracker;
  }
  function parseSourceKey(v) {
    var p = String(v).split(':');
    if (p[0] === 'fronius') return { kind: 'fronius_mppt', host: p.slice(1, -1).join(':'), mppt: Number(p[p.length - 1]) };
    return { kind: 'victron_vrm_tracker', instance: Number(p[1]), tracker: Number(p[2]) };
  }

  function sourceLabel(t) {
    if (t.kind === 'fronius_mppt') {
      return 'Fronius ' + t.host + ' · MPPT ' + t.mppt + (t.powerW != null ? ' (jetzt ' + (t.powerW / 1000).toFixed(1) + ' kW)' : '');
    }
    return 'Victron Laderegler ' + t.instance + ' · Tracker ' + (t.tracker + 1) + (t.name ? ' „' + t.name + '“' : '');
  }

  function sourceOptions(row) {
    var list = trackers.map(function (t) { return Object.assign({ kind: 'victron_vrm_tracker' }, t); })
      .concat(mppts.map(function (m) { return Object.assign({ kind: 'fronius_mppt' }, m); }));
    var key = sourceKey(row);
    var has = list.some(function (t) { return sourceKey(t) === key; });
    if (!has) list.push(row);
    return list.map(function (t) {
      var v = sourceKey(t);
      return '<option value="' + esc(v) + '"' + (v === key ? ' selected' : '') + '>' + esc(sourceLabel(t)) + '</option>';
    }).join('');
  }

  function rowId(r, i) { return r.id || ('neu-' + i); }

  function renderRows() {
    var host = el('pvs-rows');
    if (!host) return;
    if (!rows.length) {
      host.innerHTML = '<p class="field-hint">Noch keine Strings. &bdquo;Tracker aus VRM holen&ldquo; oder &bdquo;MPPTs vom Fronius holen&ldquo; schl&auml;gt sie vor.</p>';
      return;
    }
    host.innerHTML = rows.map(function (r, i) {
      return '<div class="pvs-row" data-i="' + i + '">'
        + '<input type="text" class="input pvs-label" value="' + esc(r.label) + '" placeholder="Name, z. B. Süd A" aria-label="Name">'
        + '<select class="input pvs-tracker" aria-label="Quelle">' + sourceOptions(r) + '</select>'
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
      var src = parseSourceKey(node.querySelector('.pvs-tracker').value);
      delete r.instance; delete r.tracker; delete r.host; delete r.mppt;
      Object.assign(r, src);
      var k = node.querySelector('.pvs-kwp').value;
      r.kwp = k === '' ? null : Number(k);
    });
  }

  function renderGroups() {
    var host = el('pvs-groups');
    if (!host) return;
    if (!groups.length) { host.innerHTML = ''; return; }
    host.innerHTML = groups.map(function (g, gi) {
      var boxes = rows.map(function (r, i) {
        var id = rowId(r, i);
        var on = g.members.indexOf(id) >= 0 ? ' checked' : '';
        return '<label><input type="checkbox" class="pvs-group-member" value="' + esc(id) + '"' + on + '>' + esc(r.label || id) + '</label>';
      }).join('');
      return '<div class="pvs-group" data-g="' + gi + '">'
        + '<div class="pvs-group-head">'
        + '<input type="text" class="input pvs-group-label" value="' + esc(g.label) + '" placeholder="Name, z. B. Süd gesamt" aria-label="Gruppenname">'
        + '<button type="button" class="btn sm ghost pvs-group-remove" aria-label="Gruppe entfernen">&times;</button>'
        + '</div>'
        + '<div class="pvs-group-members">' + (boxes || '<span class="field-hint">Erst Strings anlegen.</span>') + '</div>'
        + '</div>';
    }).join('');
  }

  function readGroups() {
    var host = el('pvs-groups');
    if (!host) return;
    host.querySelectorAll('.pvs-group').forEach(function (node) {
      var g = groups[Number(node.getAttribute('data-g'))];
      if (!g) return;
      g.label = node.querySelector('.pvs-group-label').value.trim();
      g.members = Array.prototype.map.call(node.querySelectorAll('.pvs-group-member:checked'), function (c) { return c.value; });
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
        + '<span class="pvs-meta">' + (s.kwp ? esc(s.kwp) + ' kWp · ' : '') + esc(overviewSource(s, src)) + '</span></div>'
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

  function overviewSource(s, all) {
    if (s.kind === 'group') {
      return 'Summe: ' + s.members.map(function (m) {
        var hit = all.filter(function (x) { return x.id === m; })[0];
        return hit ? hit.label : m;
      }).join(' + ');
    }
    if (s.kind === 'fronius_mppt') return 'Fronius · MPPT ' + s.mppt;
    return 'Victron · Tracker ' + (s.tracker + 1);
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
      var editing = document.activeElement && (el('pvs-rows').contains(document.activeElement) || el('pvs-groups').contains(document.activeElement));
      if ((!rows.length && !groups.length) || !editing) {
        var all = data.sources || [];
        rows = all.filter(function (s) { return s.kind !== 'group'; }).map(function (s) {
          var r = { id: s.id, label: s.label, kind: s.kind, kwp: s.kwp };
          if (s.kind === 'fronius_mppt') { r.host = s.host; r.mppt = s.mppt; } else { r.instance = s.instance; r.tracker = s.tracker; }
          return r;
        });
        groups = all.filter(function (s) { return s.kind === 'group'; }).map(function (g) {
          return { id: g.id, label: g.label, members: g.members.slice() };
        });
        var fh = el('pvs-fronius-host');
        var firstFronius = rows.filter(function (r) { return r.kind === 'fronius_mppt'; })[0];
        if (fh && !fh.value && firstFronius) fh.value = firstFronius.host;
        renderRows();
        renderGroups();
      }
      var needsVrm = rows.some(function (r) { return r.kind !== 'fronius_mppt'; });
      if (needsVrm && !data.vrmConfigured) banner('pvs-banner', 'VRM-Zugang fehlt — erst unter „VRM Cloud“ Portal-ID und Token eintragen.', 'error');
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
      var exists = rows.some(function (r) { return r.kind !== 'fronius_mppt' && r.instance === t.instance && r.tracker === t.tracker; });
      if (exists) return;
      rows.push({ id: null, label: t.name || ('Tracker ' + (t.tracker + 1)), kind: 'victron_vrm_tracker', instance: t.instance, tracker: t.tracker, kwp: null });
      added += 1;
    });
    renderRows();
    renderGroups();
    banner('pvs-banner', trackers.length + ' Tracker gefunden' + (added ? ', ' + added + ' vorgeschlagen — Namen anpassen und speichern.' : '.'), 'ok');
  }

  async function discoverFronius() {
    readRows();
    readGroups();
    var host = (el('pvs-fronius-host') && el('pvs-fronius-host').value || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (!host) { banner('pvs-banner', 'Erst die Adresse des Fronius eintragen.', 'error'); return; }
    banner('pvs-banner', 'Frage den Fronius nach seinen MPPT-Eingängen …');
    var res = await apiFetch('/api/pv-strings/discover-fronius?host=' + encodeURIComponent(host));
    var data = await json(res);
    if (!res.ok || !data.ok) { banner('pvs-banner', data.error || ('HTTP ' + res.status), 'error'); return; }
    mppts = mppts.filter(function (m) { return m.host !== data.host; }).concat(data.mppts || []);
    var added = 0;
    (data.mppts || []).forEach(function (m) {
      var exists = rows.some(function (r) { return r.kind === 'fronius_mppt' && r.host === m.host && r.mppt === m.mppt; });
      if (exists) return;
      rows.push({ id: null, label: 'Fronius MPPT ' + m.mppt, kind: 'fronius_mppt', host: m.host, mppt: m.mppt, kwp: null });
      added += 1;
    });
    renderRows();
    renderGroups();
    banner('pvs-banner', (data.mppts || []).length + ' MPPT-Eingänge gefunden' + (added ? ', ' + added + ' vorgeschlagen — Namen anpassen und speichern.' : '.'), 'ok');
  }

  async function save() {
    readRows();
    readGroups();
    var used = {};
    var idMap = {};
    var sources = rows.map(function (r, i) {
      var id = r.id || slug(r.label);
      var base = id; var n = 2;
      while (used[id]) { id = base.slice(0, 29) + '-' + n; n += 1; }
      used[id] = true;
      idMap[rowId(r, i)] = id;
      r.id = id;
      var s = r.kind === 'fronius_mppt'
        ? { id: id, label: r.label || id, kind: 'fronius_mppt', host: r.host, mppt: r.mppt }
        : { id: id, label: r.label || id, kind: 'victron_vrm_tracker', instance: r.instance, tracker: r.tracker };
      if (r.kwp > 0) s.kwp = r.kwp;
      return s;
    });
    var groupList = [];
    for (var gi = 0; gi < groups.length; gi += 1) {
      var g = groups[gi];
      var members = g.members.map(function (m) { return idMap[m] || m; }).filter(function (m) { return used[m]; });
      if (members.length < 2) { banner('pvs-banner', 'Gruppe „' + (g.label || 'ohne Namen') + '“ braucht mindestens zwei Strings.', 'error'); return; }
      var gid = g.id || slug(g.label || 'gruppe');
      var gbase = gid; var gn = 2;
      while (used[gid]) { gid = gbase.slice(0, 29) + '-' + gn; gn += 1; }
      used[gid] = true;
      g.id = gid;
      g.members = members;
      groupList.push({ id: gid, label: g.label || gid, members: members });
    }
    var res = await apiFetch('/api/pv-strings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !!(el('pvs-enabled') && el('pvs-enabled').checked), sources: sources, groups: groupList })
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
    if (e.target.closest('#pvs-fronius-discover')) { discoverFronius(); return; }
    if (e.target.closest('#pvs-group-add')) {
      readRows();
      readGroups();
      groups.push({ id: null, label: '', members: [] });
      renderGroups();
      return;
    }
    var grm = e.target.closest('.pvs-group-remove');
    if (grm) {
      readGroups();
      groups.splice(Number(grm.closest('.pvs-group').getAttribute('data-g')), 1);
      renderGroups();
      return;
    }
    if (e.target.closest('#pvs-save')) { save(); return; }
    if (e.target.closest('#pvs-backfill')) { backfill(); return; }
    var rm = e.target.closest('.pvs-remove');
    if (rm) {
      readRows();
      readGroups();
      var i = Number(rm.closest('.pvs-row').getAttribute('data-i'));
      var gone = rowId(rows[i], i);
      rows.splice(i, 1);
      groups.forEach(function (g) { g.members = g.members.filter(function (m) { return m !== gone; }); });
      renderRows();
      renderGroups();
      return;
    }
    var csv = e.target.closest('.pvs-csv');
    if (csv) downloadCsv(csv.getAttribute('data-id'));
  });

  window.DVhubPvStrings = { load: load };
})();
