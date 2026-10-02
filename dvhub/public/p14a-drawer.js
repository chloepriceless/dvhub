// p14a-drawer.js -- Integrationen → §14a (steuerbare Verbrauchseinrichtungen).
// Mindestleistung Pmin,14a mit Rechenweg, Geräteliste (automatisch erkannt und
// von Hand), Relais der Steuerbox und die aktuelle Begrenzung samt Aufteilung.
// Geöffnet von integrations.js (openDrawerForSystem('p14a')).
(function () {
  'use strict';

  let pollTimer = null;
  let last = null;

  const KINDS = {
    ladepunkt: 'Ladepunkt (Wallbox)',
    waermepumpe: 'Wärmepumpe',
    klima: 'Raumkühlung (Klima)',
    speicher: 'Stromspeicher',
  };
  const FORMULA = {
    none: 'keine steuerbare Verbrauchseinrichtung',
    single: 'eine SteuVE: 4,2 kW',
    standard: '4,2 kW + (n − 1) × GZF × 4,2 kW',
    large_hp_ac: 'max(0,4 × ΣP Wärmepumpen ; 0,4 × ΣP Klima) + (n − 1) × GZF × 4,2 kW',
  };
  const IGNORED = {
    not_above_4200w: 'bis 4,2 kW — keine SteuVE',
    group_not_above_4200w: 'Fallgruppe zusammen bis 4,2 kW — keine SteuVE',
    unknown_kind_or_power: 'Art oder Leistung fehlt',
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
    const t = el('dv-drawer-p14a-toast');
    if (!t) return;
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, 4000);
  }
  function kw(w) {
    if (w == null || !Number.isFinite(Number(w))) return '—';
    return (Number(w) / 1000).toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' kW';
  }

  function manualDevices(st) {
    return (st.devices || []).filter(function (d) { return d.source === 'manual'; })
      .map(function (d) { return { id: d.id, name: d.name, kind: d.kind, powerW: d.powerW, control: d.control }; });
  }

  async function saveDevices(list) {
    const res = await apiFetch('/api/p14a/devices', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devices: list }),
    });
    const j = await json(res);
    if (!res.ok || !j.ok) { toast('Speichern fehlgeschlagen: ' + (j.error || res.status)); return; }
    toast('Gespeichert');
    render(j);
  }

  function render(st) {
    last = st;
    const box = el('p14a-content');
    if (!box) return;
    let html = '';

    // Aktueller Zustand
    html += '<section class="eebus-sec"><h3>Jetzt</h3>';
    if (st.active) {
      html += '<div><strong>Bezug begrenzt:</strong> ≤ ' + esc(kw(st.limitW)) + ' (' + (st.source === 'relay' ? 'Relais' : 'EEBUS-Steuerbox') + ')</div>';
      html += '<div class="eebus-small">Budget mit PV-Überschuss: ' + esc(kw(st.budgetW)) + '</div>';
      if (st.belowPmin) html += '<div class="eebus-error">Die Vorgabe liegt unter der Mindestleistung von ' + esc(kw(st.pminW)) + '. DVhub hält sie trotzdem ein (Ziffer 4.6) — beim Netzbetreiber klären.</div>';
      const parts = (st.devices || []).filter(function (d) { return d.controllable; }).map(function (d) {
        const w = st.shares ? st.shares[d.id] : null;
        return esc(d.name || KINDS[d.kind] || d.kind) + ': ' + (w == null ? '—' : w > 0 ? '≤ ' + esc(kw(w)) : 'gesperrt');
      });
      if (parts.length) html += '<div class="eebus-small">Aufteilung: ' + parts.join(' · ') + '</div>';
    } else {
      html += '<div><strong>Bezug:</strong> frei — keine Vorgabe des Netzbetreibers</div>';
    }
    if (st.relay && st.relay.enabled) {
      const lvl = st.relay.level;
      const dimmed = lvl != null && lvl === st.relay.activeWhen;
      html += '<div class="eebus-small">Relais (' + esc(st.relay.topic) + '): '
        + (lvl == null ? 'kein Signal empfangen' : (lvl === 'high' ? 'geschlossen / 1' : 'offen / 0') + ' → ' + (dimmed ? 'gedimmt' : 'frei')) + '</div>';
    } else {
      html += '<div class="eebus-small">Relais: aus (Einstellungen → System → §14a)</div>';
    }
    html += '</section>';

    // Mindestleistung
    html += '<section class="eebus-sec"><h3>Mindestleistung Pmin,14a</h3>';
    html += '<div><strong>' + esc(kw(st.pminW)) + '</strong>'
      + (st.n > 1 ? ' · ' + st.n + ' SteuVE, Gleichzeitigkeitsfaktor ' + String(st.gzf).replace('.', ',') : st.n === 1 ? ' · 1 SteuVE' : '') + '</div>';
    html += '<div class="eebus-small">' + esc(FORMULA[st.formula] || '') + '</div>';
    html += '<div class="eebus-small">Ab einer Begrenzung durch das Relais gilt dieser Wert, mindestens 4,2 kW. '
      + 'Eine EEBUS-Steuerbox schickt ihren Wert selbst.</div>';
    html += '</section>';

    // Geräte
    html += '<section class="eebus-sec"><h3>Geräte</h3><ul class="eebus-list">';
    const devices = st.devices || [];
    if (!devices.length) html += '<li class="muted">Keine Geräte — Wallbox, Speicher und EEBUS-Geräte erkennt DVhub selbst, andere hier eintragen.</li>';
    devices.forEach(function (d) {
      const ignored = (st.ignored || []).find(function (i) { return i.id === d.id; });
      html += '<li><strong>' + esc(d.name || KINDS[d.kind] || d.kind) + '</strong> · ' + esc(KINDS[d.kind] || d.kind) + ' · ' + esc(kw(d.powerW))
        + '<div class="eebus-small">'
        + (d.source === 'manual' ? 'von Hand' : d.source === 'eebus' ? 'EEBUS' : 'automatisch')
        + (d.control === 'direct' ? ' · Direktsteuerung (eigene Mindestleistung, nicht in der EMS-Formel)' : '')
        + (d.controllable ? ' · von DVhub gesteuert' : ' · nicht von DVhub gesteuert')
        + (ignored ? ' · ' + esc(IGNORED[ignored.reason] || ignored.reason) : '')
        + '</div>'
        + (d.source === 'manual' ? '<button type="button" class="btn sm ghost" data-p14a-remove="' + esc(d.id) + '">Entfernen</button>' : '')
        + '</li>';
    });
    html += '</ul>';
    html += '<h4>Gerät hinzufügen</h4><div class="eebus-manual">'
      + '<input type="text" class="input" id="p14a-new-name" placeholder="Name, z. B. Wärmepumpe Keller" maxlength="60">'
      + '<select class="input" id="p14a-new-kind">'
      + Object.keys(KINDS).map(function (k) { return '<option value="' + k + '">' + esc(KINDS[k]) + '</option>'; }).join('')
      + '</select>'
      + '<input type="number" class="input" id="p14a-new-kw" placeholder="kW" min="0.1" step="0.1" style="width:6em">'
      + '<select class="input" id="p14a-new-control"><option value="ems">über DVhub (EMS)</option><option value="direct">Direktsteuerung</option></select>'
      + '<button type="button" class="btn sm" id="p14a-add">Hinzufügen</button>'
      + '</div><div class="eebus-small">Netzanschlussleistung wie beim Netzbetreiber angemeldet. Mehrere Wärmepumpen bzw. Klimaanlagen zählen je Fallgruppe als eine SteuVE.</div>';
    html += '</section>';

    box.innerHTML = html;

    box.querySelectorAll('[data-p14a-remove]').forEach(function (b) {
      b.addEventListener('click', function () {
        const id = b.getAttribute('data-p14a-remove');
        saveDevices(manualDevices(last).filter(function (d) { return d.id !== id; }));
      });
    });
    const add = el('p14a-add');
    if (add) add.addEventListener('click', function () {
      const powerW = Math.round(Number(String(el('p14a-new-kw').value).replace(',', '.')) * 1000);
      if (!(powerW > 0)) { toast('Bitte die Leistung in kW eintragen'); return; }
      const list = manualDevices(last);
      list.push({
        id: 'manual-' + Date.now().toString(36),
        name: el('p14a-new-name').value.trim(),
        kind: el('p14a-new-kind').value,
        powerW: powerW,
        control: el('p14a-new-control').value,
      });
      saveDevices(list);
    });
  }

  async function load() {
    const box = el('p14a-content');
    clearTimeout(pollTimer);
    try {
      const res = await apiFetch('/api/p14a/status');
      const j = await json(res);
      if (!res.ok || !j.ok) {
        if (box) box.innerHTML = '<p class="muted">§14a nicht verfügbar.</p>';
      } else {
        // Eingaben nicht beim Tippen überschreiben.
        const active = document.activeElement;
        const typing = active && box && box.contains(active) && /INPUT|SELECT/.test(active.tagName);
        if (!typing) render(j);
      }
    } catch (e) {
      if (box) box.innerHTML = '<p class="muted">Fehler: ' + esc(e.message) + '</p>';
    }
    const root = el('dv-drawer-p14a');
    if (root && !root.hidden) pollTimer = setTimeout(load, 5000);
  }

  window.DVhubP14a = { load: load };
})();
