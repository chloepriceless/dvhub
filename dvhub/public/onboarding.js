// onboarding.js — Erst-Setup-Assistent (Aurora)
//
// Token-freier First-Run-Flow für eine frische / vorinstallierte Box. Spricht
// ausschließlich die self-guarded Setup-Endpunkte an (GET /api/setup/state,
// POST /api/setup/complete) sowie die LAN-sichere Geräte-Discovery. Beim
// Abschluss beansprucht der Browser den echten Box-Token (setStoredApiToken),
// danach greift die normale (restricted) Authentifizierung wieder.
(function () {
  'use strict';

  const common = (typeof window !== 'undefined' && window.DVhubCommon) || {};
  const apiFetch = common.apiFetch || ((p, o) => fetch(p, o));
  const setStoredApiToken = common.setStoredApiToken || function () {};

  const STEPS = ['welcome', 'plant', 'location', 'done'];
  const DOT_STEPS = ['welcome', 'plant', 'location'];
  let stepIndex = 0;
  let discovering = false;

  const byId = (id) => document.getElementById(id);

  // ── Navigation ───────────────────────────────────────────────────────
  function showStep(name) {
    const idx = STEPS.indexOf(name);
    if (idx < 0) return;
    stepIndex = idx;
    document.querySelectorAll('.ob-step').forEach((el) => {
      el.hidden = el.getAttribute('data-step') !== name;
    });
    renderDots();
    hideBanner();
    const active = document.querySelector('.ob-step[data-step="' + name + '"]');
    const focusable = active && active.querySelector('input, button');
    if (focusable) { try { focusable.focus({ preventScroll: true }); } catch (_) { /* noop */ } }
  }

  function renderDots() {
    const wrap = byId('obDots');
    if (!wrap) return;
    wrap.innerHTML = '';
    const here = (stepIndex >= STEPS.length - 1)
      ? DOT_STEPS.length
      : DOT_STEPS.indexOf(STEPS[stepIndex]);
    DOT_STEPS.forEach((_, i) => {
      const dot = document.createElement('span');
      if (i < here) dot.classList.add('is-done');
      else if (i === here) dot.classList.add('is-active');
      wrap.appendChild(dot);
    });
  }

  function next() {
    if (STEPS[stepIndex] === 'plant') {
      const host = (byId('obHost').value || '').trim();
      if (!host) {
        fieldErr('obHostErr', 'Bitte die Anlagenadresse eingeben oder im Netzwerk suchen.');
        byId('obHost').focus();
        return;
      }
      fieldErr('obHostErr', '');
    }
    showStep(STEPS[Math.min(stepIndex + 1, STEPS.length - 1)]);
  }

  function back() {
    showStep(STEPS[Math.max(stepIndex - 1, 0)]);
  }

  // ── Banner / Feldfehler ──────────────────────────────────────────────
  function showBanner(msg, kind) {
    const b = byId('obBanner');
    if (!b) return;
    b.textContent = msg;
    b.className = 'ob-banner' + (kind === 'info' ? ' is-info' : '');
    b.hidden = false;
  }
  function hideBanner() { const b = byId('obBanner'); if (b) b.hidden = true; }

  function fieldErr(id, msg) {
    const el = byId(id);
    if (!el) return;
    if (msg) { el.textContent = msg; el.hidden = false; }
    else { el.hidden = true; }
  }

  // ── Prefill ──────────────────────────────────────────────────────────
  async function loadState() {
    try {
      const res = await apiFetch('/api/setup/state');
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.needsSetup === false) {
        // Bereits eingerichtet (z.B. Reload nach Abschluss) → Leitstand.
        window.location.replace('/');
        return;
      }
      if (data && typeof data.victronHost === 'string' && data.victronHost) {
        byId('obHost').value = data.victronHost;
      }
      if (data && data.location) {
        if (data.location.latitude != null) byId('obLat').value = data.location.latitude;
        if (data.location.longitude != null) byId('obLon').value = data.location.longitude;
      }
    } catch (_) {
      // Frischer Boot / offline — der Assistent wird trotzdem angezeigt.
    }
  }

  // ── Discovery ────────────────────────────────────────────────────────
  async function runDiscovery() {
    if (discovering) return;
    discovering = true;
    const btn = byId('obDiscover');
    const list = byId('obDiscovery');
    btn.classList.add('is-loading');
    list.innerHTML = '';
    fieldErr('obHostErr', '');
    try {
      const res = await apiFetch('/api/discovery/systems?manufacturer=victron');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || String(res.status));
      }
      renderDiscovery(Array.isArray(data.systems) ? data.systems : []);
    } catch (_) {
      list.innerHTML = '<p class="ob-disc-empty">Automatische Suche nicht möglich. Bitte die Adresse manuell eingeben.</p>';
    } finally {
      btn.classList.remove('is-loading');
      discovering = false;
    }
  }

  function renderDiscovery(systems) {
    const list = byId('obDiscovery');
    list.innerHTML = '';
    if (!systems.length) {
      list.innerHTML = '<p class="ob-disc-empty">Kein System gefunden. Bitte die Adresse manuell eingeben.</p>';
      return;
    }
    systems.forEach((sys) => {
      const ip = sys.ipv4 || sys.ip || sys.ipv6 || sys.host || '';
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'ob-disc-item';
      const title = document.createElement('strong');
      title.textContent = sys.label || sys.host || 'Victron System';
      const sub = document.createElement('span');
      sub.textContent = ip || '–';
      item.appendChild(title);
      item.appendChild(sub);
      item.addEventListener('click', () => {
        byId('obHost').value = ip;
        Array.from(list.children).forEach((c) => {
          if (c.classList) c.classList.remove('is-selected');
        });
        item.classList.add('is-selected');
        fieldErr('obHostErr', '');
      });
      list.appendChild(item);
    });
  }

  // ── Abschluss ────────────────────────────────────────────────────────
  async function finish() {
    const host = (byId('obHost').value || '').trim();
    if (!host) {
      showStep('plant');
      fieldErr('obHostErr', 'Bitte die Anlagenadresse eingeben.');
      return;
    }
    const latRaw = (byId('obLat').value || '').trim();
    const lonRaw = (byId('obLon').value || '').trim();
    const payload = { victronHost: host };
    if (latRaw !== '' || lonRaw !== '') {
      const lat = Number(latRaw);
      const lon = Number(lonRaw);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90
        || !Number.isFinite(lon) || lon < -180 || lon > 180) {
        fieldErr('obLocErr', 'Bitte gültige Koordinaten eingeben oder das Feld leer lassen.');
        return;
      }
      payload.location = { latitude: lat, longitude: lon };
    }
    fieldErr('obLocErr', '');

    const btn = byId('obFinish');
    const skip = byId('obSkip');
    btn.disabled = true;
    if (skip) skip.disabled = true;
    btn.textContent = 'Wird gespeichert…';
    try {
      const res = await apiFetch('/api/setup/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || ('HTTP ' + res.status));
      }
      if (data.apiToken) setStoredApiToken(data.apiToken);
      showStep('done');
      if (data.restartRequired) {
        byId('obDoneSub').textContent =
          'Dein Zugang ist gesichert. Einige Verbindungswerte werden nach einem kurzen Dienst-Neustart aktiv. Weiterleitung zum Leitstand…';
      }
      window.setTimeout(() => { window.location.replace('/'); }, 2200);
    } catch (e) {
      btn.disabled = false;
      if (skip) skip.disabled = false;
      btn.textContent = 'Einrichtung abschließen';
      showBanner('Einrichtung fehlgeschlagen: ' + (e.message || 'unbekannter Fehler') + '. Bitte erneut versuchen.');
    }
  }

  // ── Verdrahtung ──────────────────────────────────────────────────────
  function wire() {
    document.querySelectorAll('[data-next]').forEach((b) => b.addEventListener('click', next));
    document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', back));
    const skip = byId('obSkip');
    if (skip) skip.addEventListener('click', () => {
      byId('obLat').value = '';
      byId('obLon').value = '';
      finish();
    });
    const finishBtn = byId('obFinish');
    if (finishBtn) finishBtn.addEventListener('click', finish);
    const discover = byId('obDiscover');
    if (discover) discover.addEventListener('click', runDiscovery);
    const hostInput = byId('obHost');
    if (hostInput) {
      hostInput.addEventListener('input', () => fieldErr('obHostErr', ''));
      hostInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); next(); }
      });
    }
    window.addEventListener('dvhub:unauthorized', () => {
      showBanner('Während der Einrichtung ist kein Zugriff möglich. Bitte sicherstellen, dass du im selben Netzwerk wie die Box bist.');
    });
  }

  function init() {
    wire();
    showStep('welcome');
    loadState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
