// build-watch.js -- neue DVhub-Version erkennen und die Seite neu laden
// (T-0423, Christin 11.11.2026). Anlass: nach dem Update auf test-5 zeigte die
// offene Home-Screen-Webapp die alte E-Auto-Kachel ohne Wochenplan, bis sie
// von Hand geschlossen wurde.
//
// Quelle: der Server hängt an jede JSON-Antwort die Build-Kennung der
// Oberfläche (Kopfzeile X-DVhub-Build, dvhub/ui-build.js: Version + Inhalt
// von public/). common.js reicht jede apiFetch-Antwort hierher weiter — die
// vorhandenen Status-Abfragen der Seiten genügen, kein neuer Dauer-Poll. Beim
// Zurückkehren in die Webapp (visibilitychange, pageshow aus dem
// Zurück-Cache, focus, online) fragt die Seite einmal /health ab.
//
// Ablauf: erste gesehene Kennung = Stand der Seite. Eine andere Kennung muss
// sich ein zweites Mal zeigen (Poll oder Abruf nach 2 s) — ein Wackler beim
// Update zählt nicht. Dann:
//   · nichts in Bearbeitung → kurzer Hinweis, nach 1,5 s neu laden;
//   · in Bearbeitung (offener Dialog/Seitenleiste, Fokus im Eingabefeld,
//     ungespeicherte Einstellungen, Entwurf der E-Auto-Kachel, Eingabe ohne
//     anschließendes Speichern) → Hinweis mit Knopf „Neu laden“, sobald frei
//     automatisch;
//   · Sperre gegen Schleifen: für dieselbe Kennung höchstens einmal je 10 min
//     (je Kennung gemerkt, auch wenn dazwischen eine andere kam), überhaupt
//     höchstens einmal je Minute; lässt sich die Sperre nicht speichern
//     (Sitzungsspeicher gesperrt oder voll), nie automatisch — dann bleibt nur
//     der Hinweis.
(function (root) {
  'use strict';

  const GUARD_KEY = 'dvhub.buildReload';
  const DEFAULTS = {
    confirmDelayMs: 2000,       // zweiter Blick, bevor etwas passiert
    reloadDelayMs: 1500,        // Hinweis kurz zeigen, dann neu laden
    idleCheckMs: 2000,          // beim Warten: alle 2 s schauen, ob frei (lokal, kein Abruf)
    sameBuildGuardMs: 10 * 60 * 1000,
    anyReloadGuardMs: 60 * 1000,
    checkMinIntervalMs: 5000    // Abruf bei Rückkehr höchstens alle 5 s
  };
  const EDIT_IDLE_MS = 15 * 60 * 1000;
  const GUARD_MAX_BUILDS = 20;
  // Schreibaufrufe, die nichts speichern (Vorschau beim Tippen, Verbindungstest,
  // Daten neu holen) — sie geben eine Eingabe nicht frei (Codex 863eaeed, P1).
  const NON_SAVING_WRITE = /\/(preview|test|refresh|backfill)(\/|\?|$)/i;
  const NON_TEXT_INPUTS = { button: 1, submit: 1, reset: 1, checkbox: 1, radio: 1, range: 1, color: 1, file: 1, image: 1, hidden: 1 };
  const NON_EDIT_INPUTS = { button: 1, submit: 1, reset: 1, image: 1, hidden: 1 };

  function normalizeBuild(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim().toLowerCase();
    return /^[0-9a-f]{8,64}$/.test(v) ? v : null;
  }

  // ---------------------------------------------------------------- Sperre

  // Datensatz { last: <Zeitpunkt der letzten Neuladung>, builds: { <Kennung>: <Zeitpunkt> } }.
  // undefined = Speicher nicht nutzbar, null = noch nie neu geladen.
  function readGuard(storage) {
    if (!storage) return undefined;
    let raw;
    try { raw = storage.getItem(GUARD_KEY); } catch (_) { return undefined; }
    if (!raw) return null;
    try {
      const rec = JSON.parse(raw);
      if (rec && Number.isFinite(rec.last) && rec.builds && typeof rec.builds === 'object') return rec;
      // Erste Fassung (863eaeed) schrieb { id, at } — weiter als Sperre lesen.
      if (rec && typeof rec.id === 'string' && Number.isFinite(rec.at)) {
        const builds = {};
        if (rec.id) builds[rec.id] = rec.at;
        return { last: rec.at, builds: builds };
      }
    } catch (_) { /* kaputt = wie nie */ }
    return null;
  }

  const within = (at, now, ms) => Number.isFinite(at) && now - at >= 0 && now - at < ms;

  // Merkt die Neuladung; Einträge älter als die Sperrzeit fallen weg, höchstens
  // GUARD_MAX_BUILDS (die jüngsten). false = nicht gespeichert.
  function writeGuard(storage, id, now, o) {
    if (!storage) return false;
    const prev = readGuard(storage);
    const builds = {};
    if (prev && prev.builds) {
      const kept = Object.keys(prev.builds)
        .filter((b) => within(prev.builds[b], now, o.sameBuildGuardMs))
        .sort((a, b) => prev.builds[b] - prev.builds[a])
        .slice(0, GUARD_MAX_BUILDS - 1);
      for (const b of kept) builds[b] = prev.builds[b];
    }
    if (id) builds[id] = now;
    try { storage.setItem(GUARD_KEY, JSON.stringify({ last: now, builds: builds })); return true; } catch (_) { return false; }
  }

  function guardAllows(storage, id, now, o) {
    const rec = readGuard(storage);
    if (rec === undefined) return false;
    if (rec === null) return true;
    if (within(rec.last, now, o.anyReloadGuardMs)) return false;
    if (within(rec.builds[id], now, o.sameBuildGuardMs)) return false;
    return true;
  }

  function isSavingWrite(url) {
    let p = String(url || '');
    try { p = new URL(p, 'http://x').pathname; } catch (_) { /* roh prüfen */ }
    return !NON_SAVING_WRITE.test(p);
  }

  // ---------------------------------------------------------------- Ablauf

  function createController(deps) {
    const o = {};
    let k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    if (deps.options) for (k in deps.options) o[k] = deps.options[k];
    const now = deps.now || Date.now;
    const setT = deps.setTimeout;
    const clearT = deps.clearTimeout;

    let baseline = null;
    let candidate = null;
    let seen = 0;
    let mode = 'idle';          // idle | confirming | reloading | waiting | manual | done
    let confirmTimer = null;
    let reloadTimer = null;
    let idleTimer = null;
    let lastCheckAt = -Infinity;
    let checking = false;

    function clearTimers() {
      if (confirmTimer) { clearT(confirmTimer); confirmTimer = null; }
      if (reloadTimer) { clearT(reloadTimer); reloadTimer = null; }
      if (idleTimer) { clearT(idleTimer); idleTimer = null; }
    }

    function resetCandidate() {
      const hadNotice = mode === 'reloading' || mode === 'waiting' || mode === 'manual';
      clearTimers();
      candidate = null;
      seen = 0;
      mode = 'idle';
      if (hadNotice && deps.hideNotice) deps.hideNotice();
    }

    function busy() {
      try { return !!deps.isBusy(); } catch (_) { return true; }
    }

    function notice(m) {
      if (deps.showNotice) deps.showNotice(m);
    }

    // auto: nur, wenn die Sperre gespeichert ist (sonst droht eine Schleife,
    // Codex 863eaeed P2) — dann bleibt der Hinweis. Der Knopf lädt immer.
    function finish(auto) {
      const stored = writeGuard(deps.storage, candidate || baseline || '', now(), o);
      if (auto && !stored) {
        clearTimers();
        mode = 'manual';
        notice('manual');
        return;
      }
      clearTimers();
      mode = 'done';
      deps.reload();
    }

    function waitForIdle() {
      mode = 'waiting';
      notice('waiting');
      if (idleTimer) return;
      idleTimer = setT(function tick() {
        idleTimer = null;
        if (mode !== 'waiting') return;
        if (busy()) { idleTimer = setT(tick, o.idleCheckMs); return; }
        // Frei (gespeichert, Dialog zu): der Hinweis stand schon — gleich laden.
        if (!guardAllows(deps.storage, candidate, now(), o)) { mode = 'manual'; notice('manual'); return; }
        finish(true);
      }, o.idleCheckMs);
    }

    function act() {
      if (mode === 'done' || !candidate) return;
      if (confirmTimer) { clearT(confirmTimer); confirmTimer = null; }
      if (!guardAllows(deps.storage, candidate, now(), o)) {
        clearTimers();
        mode = 'manual';
        notice('manual');
        return;
      }
      if (busy()) { waitForIdle(); return; }
      mode = 'reloading';
      notice('reloading');
      if (reloadTimer) clearT(reloadTimer);
      reloadTimer = setT(function () {
        reloadTimer = null;
        if (mode !== 'reloading') return;
        if (busy()) { waitForIdle(); return; }
        finish(true);
      }, o.reloadDelayMs);
    }

    function scheduleConfirm() {
      if (confirmTimer) return;
      confirmTimer = setT(function () {
        confirmTimer = null;
        if (mode !== 'confirming') return;
        fetchAndObserve();
      }, o.confirmDelayMs);
    }

    function fetchAndObserve() {
      let p;
      try { p = deps.fetchBuild(); } catch (_) { return Promise.resolve(); }
      return Promise.resolve(p).then(observe, function () { /* nicht erreichbar: später */ });
    }

    function observe(raw) {
      if (mode === 'done') return;
      const id = normalizeBuild(raw);
      if (!id) return;
      if (baseline === null) { baseline = id; return; }
      if (id === baseline) { if (candidate !== null) resetCandidate(); return; }
      if (id !== candidate) {
        resetCandidate();
        candidate = id;
        seen = 1;
        mode = 'confirming';
        scheduleConfirm();
        return;
      }
      if (mode === 'confirming') {
        seen += 1;
        if (seen >= 2) act();
      }
    }

    function checkNow() {
      if (mode === 'done' || checking) return;
      const t = now();
      if (t - lastCheckAt < o.checkMinIntervalMs) return;
      lastCheckAt = t;
      checking = true;
      fetchAndObserve().then(function () { checking = false; }, function () { checking = false; });
    }

    // Knopf im Hinweis: sofort, auch wenn gerade bearbeitet wird (bewusst gewählt).
    function reloadNow() {
      if (mode === 'done') return;
      finish(false);
    }

    // Hinweis zu: beim Warten bleibt das automatische Neuladen, sobald frei.
    function dismiss() {
      if (deps.hideNotice) deps.hideNotice();
    }

    function state() {
      return { baseline: baseline, candidate: candidate, mode: mode };
    }

    return { observe: observe, checkNow: checkNow, reloadNow: reloadNow, dismiss: dismiss, state: state };
  }

  // ---------------------------------------------------------------- „wird bearbeitet“

  function isShown(el) {
    if (!el) return false;
    if (el.hidden) return false;
    if (typeof el.closest === 'function' && (el.closest('[hidden]') || el.closest('[aria-hidden="true"]'))) return false;
    if (el.classList && el.classList.contains('dv-drawer')) {
      // Integrationen ab 1000 px: die Einstellungen stehen als Seiteninhalt in
      // der Mitte (immer eine gewählt) — kein Dialog; ihre Felder deckt die
      // Fokus-/Eingabe-Erkennung ab.
      if (el.classList.contains('dv-drawer--inline')) return false;
      return el.classList.contains('is-open');
    }
    if (typeof el.checkVisibility === 'function') return el.checkVisibility();
    if (typeof el.getClientRects === 'function') return el.getClientRects().length > 0;
    return true;
  }

  function isTextEntry(el) {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    const tag = String(el.tagName).toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    return !NON_TEXT_INPUTS[String(el.type || 'text').toLowerCase()];
  }

  function isEditControl(el) {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    const tag = String(el.tagName).toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    return !NON_EDIT_INPUTS[String(el.type || 'text').toLowerCase()];
  }

  const DIALOG_SELECTOR = 'dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"]';

  function createBusyDetector(opts) {
    const doc = opts.doc;
    const now = opts.now || Date.now;
    const checks = [];
    let lastEditAt = null;     // Eingabe ohne anschließendes Speichern

    function hasOpenDialog() {
      let list;
      try { list = doc.querySelectorAll(DIALOG_SELECTOR); } catch (_) { return false; }
      for (let i = 0; i < list.length; i++) if (isShown(list[i])) return true;
      return false;
    }

    function isBusy() {
      if (isTextEntry(doc.activeElement)) return true;
      if (hasOpenDialog()) return true;
      if (doc.body && doc.body.classList && doc.body.classList.contains('has-changes')) return true;
      for (let i = 0; i < checks.length; i++) {
        try { if (checks[i]()) return true; } catch (_) { /* eine kaputte Prüfung blockiert nichts */ }
      }
      if (lastEditAt !== null && now() - lastEditAt < EDIT_IDLE_MS) return true;
      return false;
    }

    return {
      isBusy: isBusy,
      noteEdit: function (target) { if (isEditControl(target)) lastEditAt = now(); },
      // Erfolgreicher Schreibaufruf = gespeichert — außer Vorschau/Test/Neu holen.
      noteWrite: function (url) { if (isSavingWrite(url)) lastEditAt = null; },
      registerUnsavedCheck: function (fn) { if (typeof fn === 'function') checks.push(fn); }
    };
  }

  const api = {
    GUARD_KEY: GUARD_KEY,
    normalizeBuild: normalizeBuild,
    isSavingWrite: isSavingWrite,
    createController: createController,
    createBusyDetector: createBusyDetector
  };
  root.DVhubBuildWatch = api;

  // ---------------------------------------------------------------- Browser

  if (typeof document === 'undefined' || typeof root.addEventListener !== 'function') return;

  const NOTICE_TEXT = {
    reloading: ['Neue DVhub-Version installiert', 'Die Seite lädt neu …'],
    waiting: ['Neue DVhub-Version installiert — neu laden', 'Lädt automatisch neu, sobald nichts mehr bearbeitet wird. Änderungen vorher speichern.'],
    manual: ['Neue DVhub-Version installiert — neu laden', 'Bitte neu laden, um die aktuelle Oberfläche zu sehen.']
  };

  // Sitzungsspeicher übersteht location.reload() im selben Tab/der Webapp;
  // nicht nutzbar (gesperrt, privates Fenster) → nie automatisch neu laden.
  function openSessionStore() {
    try {
      const s = root.sessionStorage;
      s.getItem(GUARD_KEY);
      return s;
    } catch (_) {
      return null;
    }
  }
  const sessionStore = openSessionStore();

  const detector = createBusyDetector({ doc: document, now: Date.now });
  let box = null;

  function ensureBox() {
    if (box) return box;
    box = document.createElement('div');
    box.className = 'dv-build-notice';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    box.hidden = true;
    const text = document.createElement('div');
    text.className = 'dv-build-notice-text';
    const title = document.createElement('strong');
    title.className = 'dv-build-notice-title';
    const sub = document.createElement('span');
    sub.className = 'dv-build-notice-sub';
    text.appendChild(title);
    text.appendChild(sub);
    const reloadBtn = document.createElement('button');
    reloadBtn.type = 'button';
    reloadBtn.className = 'btn primary dv-build-notice-reload';
    reloadBtn.textContent = 'Neu laden';
    reloadBtn.addEventListener('click', function () { ctrl.reloadNow(); });
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn ghost dv-build-notice-close';
    closeBtn.setAttribute('aria-label', 'Hinweis ausblenden');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', function () { ctrl.dismiss(); });
    box.appendChild(text);
    box.appendChild(reloadBtn);
    box.appendChild(closeBtn);
    (document.body || document.documentElement).appendChild(box);
    return box;
  }

  function showNotice(mode) {
    const t = NOTICE_TEXT[mode];
    if (!t || !document.body) return;
    const b = ensureBox();
    b.setAttribute('data-mode', mode);
    b.querySelector('.dv-build-notice-title').textContent = t[0];
    b.querySelector('.dv-build-notice-sub').textContent = t[1];
    b.querySelector('.dv-build-notice-close').hidden = mode === 'reloading';
    b.hidden = false;
  }

  function hideNotice() {
    if (box) box.hidden = true;
  }

  const ctrl = createController({
    now: Date.now,
    setTimeout: function (fn, ms) { return root.setTimeout(fn, ms); },
    clearTimeout: function (id) { root.clearTimeout(id); },
    storage: sessionStore,
    isBusy: detector.isBusy,
    reload: function () { root.location.reload(); },
    showNotice: showNotice,
    hideNotice: hideNotice,
    fetchBuild: function () {
      return root.fetch('/health', { cache: 'no-store', credentials: 'same-origin' })
        .then(function (res) { return res.headers.get('x-dvhub-build'); });
    }
  });

  api.observe = ctrl.observe;
  api.checkNow = ctrl.checkNow;
  api.state = ctrl.state;
  api.registerUnsavedCheck = detector.registerUnsavedCheck;

  // Eingaben merken (nur echte, vom Menschen); Speichern gibt frei.
  function onEdit(e) { if (e && e.isTrusted !== false) detector.noteEdit(e.target); }
  document.addEventListener('input', onEdit, true);
  document.addEventListener('change', onEdit, true);

  const common = root.DVhubCommon;
  if (common && typeof common.onApiResponse === 'function') {
    common.onApiResponse(function (info) {
      if (info.write && info.ok) detector.noteWrite(info.url);
      ctrl.observe(info.build);
    });
  }

  // Zurück in der Webapp (iOS aus dem Hintergrund, Tab wieder vorn, Zurück-Cache).
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') ctrl.checkNow();
  });
  root.addEventListener('pageshow', function (e) { if (e && e.persisted) ctrl.checkNow(); });
  root.addEventListener('focus', function () { ctrl.checkNow(); });
  root.addEventListener('online', function () { ctrl.checkNow(); });
  // Ausgangsstand auch auf Seiten ohne eigenen Poll (Historie, Explorer).
  ctrl.checkNow();
})(typeof window !== 'undefined' ? window : globalThis);
