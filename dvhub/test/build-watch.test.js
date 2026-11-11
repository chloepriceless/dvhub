// test/build-watch.test.js -- T-0423 (Christin 11.11.2026): Nach dem Update auf
// test-5 zeigte die offene Home-Screen-Webapp die alte E-Auto-Kachel ohne
// Wochenplan, bis sie von Hand geschlossen wurde. Die Oberfläche merkt sich
// jetzt die Build-Kennung (Kopfzeile X-DVhub-Build der vorhandenen Abfragen)
// und lädt bei einem Wechsel neu — automatisch, wenn nichts bearbeitet wird,
// sonst mit Hinweis und erst nach dem Speichern/Schließen. Kein Endlos-Reload:
// höchstens einmal je Kennung (10 min) und nicht zweimal binnen einer Minute.
//
// Reine Logik aus public/build-watch.js per vm (Controller mit gespielten
// Uhren/Timern/Abrufen, Erkennung „wird bearbeitet“ mit Attrappen-DOM).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const PUB = path.resolve(import.meta.dirname, '..', 'public');
const src = fs.readFileSync(path.join(PUB, 'build-watch.js'), 'utf8');

function load() {
  const sandbox = { window: {}, Date, Promise, JSON, Math };
  vm.runInNewContext(src, sandbox);
  return sandbox.window.DVhubBuildWatch;
}
const W = load();

const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';
const C = 'cccccccccccc';

// Gespielte Uhr + Timer (setTimeout/clearTimeout), Schritt per advance(ms).
function clock(start = 1_000_000) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t };
        if (!next) break;
        timers.delete(next.id);
        now = next.t.at;
        next.t.fn();
        await flush();
      }
      now = end;
      await flush();
    },
    pending: () => timers.size,
  };
}
async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve(); }

// Sperr-Datensatz: letzte Neuladung + je Kennung der Zeitpunkt.
function guard(builds) {
  return JSON.stringify({ last: Math.max(...Object.values(builds)), builds });
}

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

function setup({ busy = false, storage = memStorage(), fetchResults = [], options = {} } = {}) {
  const c = clock();
  const log = { reloads: 0, notices: [], hides: 0, fetches: 0 };
  let isBusy = busy;
  const results = fetchResults.slice();
  const ctrl = W.createController({
    now: c.now,
    setTimeout: c.setTimeout,
    clearTimeout: c.clearTimeout,
    storage,
    isBusy: () => isBusy,
    reload: () => { log.reloads++; },
    showNotice: (mode) => { log.notices.push(mode); },
    hideNotice: () => { log.hides++; },
    fetchBuild: () => {
      log.fetches++;
      const r = results.length ? results.shift() : null;
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    },
    options,
  });
  return { c, log, ctrl, storage, setBusy: (v) => { isBusy = v; }, push: (r) => results.push(r) };
}

describe('Kennung normalisieren', () => {
  it('nur Hex 8–64, sonst null (leere/fehlende Kopfzeile, Fremdwerte)', () => {
    assert.equal(W.normalizeBuild(' ABCDEF012345 '), 'abcdef012345');
    for (const v of [null, undefined, '', 'xyz', '1234', 'g'.repeat(12), 42, {}]) assert.equal(W.normalizeBuild(v), null, String(v));
  });
});

describe('Controller: Wechsel erkennen und neu laden', () => {
  it('erste Kennung ist der Ausgangsstand; gleiche Kennung tut nichts', async () => {
    const t = setup();
    t.ctrl.observe(A);
    t.ctrl.observe(A);
    await t.c.advance(60_000);
    assert.equal(t.ctrl.state().baseline, A);
    assert.equal(t.log.reloads, 0);
    assert.equal(t.log.notices.length, 0);
    assert.equal(t.log.fetches, 0);
  });

  it('ungültige Werte (Server nicht erreichbar, Kopfzeile fehlt) zählen nicht', async () => {
    const t = setup();
    t.ctrl.observe(null);
    t.ctrl.observe('');
    assert.equal(t.ctrl.state().baseline, null);
    t.ctrl.observe(A);
    t.ctrl.observe(null);
    await t.c.advance(10_000);
    assert.equal(t.ctrl.state().baseline, A);
    assert.equal(t.log.reloads, 0);
  });

  it('neue Kennung: erst bestätigen (zweiter Abruf), dann kurzer Hinweis und neu laden', async () => {
    const t = setup({ fetchResults: [B] });
    t.ctrl.observe(A);
    t.ctrl.observe(B);
    assert.equal(t.log.reloads, 0, 'nicht beim ersten Sehen');
    assert.equal(t.ctrl.state().mode, 'confirming');
    await t.c.advance(2_000); // Bestätigungsabruf
    assert.equal(t.log.fetches, 1);
    assert.equal(t.log.notices.at(-1), 'reloading');
    assert.equal(t.log.reloads, 0, 'kurz verzögert');
    await t.c.advance(1_500);
    assert.equal(t.log.reloads, 1);
    assert.ok(JSON.parse(t.storage.getItem(W.GUARD_KEY)).builds[B] > 0);
  });

  it('zweites Sehen über die normale Abfrage bestätigt ebenso (ohne Extra-Abruf)', async () => {
    const t = setup();
    t.ctrl.observe(A);
    t.ctrl.observe(B);
    t.ctrl.observe(B); // nächster Status-Poll
    await t.c.advance(1_500);
    assert.equal(t.log.reloads, 1);
    assert.equal(t.log.fetches, 0);
  });

  it('Bestätigung liefert wieder die alte Kennung (Update-Wackler): nichts passiert', async () => {
    const t = setup({ fetchResults: [A] });
    t.ctrl.observe(A);
    t.ctrl.observe(B);
    await t.c.advance(10_000);
    assert.equal(t.log.reloads, 0);
    assert.equal(t.ctrl.state().candidate, null);
    assert.equal(t.ctrl.state().mode, 'idle');
  });

  it('Bestätigung scheitert (Server startet noch): später per Poll bestätigt', async () => {
    const t = setup({ fetchResults: [new Error('offline')] });
    t.ctrl.observe(A);
    t.ctrl.observe(B);
    await t.c.advance(5_000);
    assert.equal(t.log.reloads, 0);
    t.ctrl.observe(B);
    await t.c.advance(1_500);
    assert.equal(t.log.reloads, 1);
  });

  it('alte Kennung während der Verzögerung: Neuladen abgebrochen, Hinweis weg', async () => {
    const t = setup();
    t.ctrl.observe(A);
    t.ctrl.observe(B);
    t.ctrl.observe(B);
    assert.equal(t.log.notices.at(-1), 'reloading');
    t.ctrl.observe(A);
    await t.c.advance(10_000);
    assert.equal(t.log.reloads, 0);
    assert.ok(t.log.hides >= 1);
  });
});

describe('Controller: wird gerade bearbeitet', () => {
  it('bearbeitet: Hinweis statt Neuladen; nach Speichern/Schließen automatisch', async () => {
    const t = setup({ busy: true });
    t.ctrl.observe(A);
    t.ctrl.observe(B);
    t.ctrl.observe(B);
    await t.c.advance(30_000);
    assert.equal(t.log.reloads, 0);
    assert.equal(t.log.notices.at(-1), 'waiting');
    assert.equal(t.ctrl.state().mode, 'waiting');
    t.setBusy(false); // gespeichert / Dialog zu
    await t.c.advance(2_000);
    assert.equal(t.log.reloads, 1);
  });

  it('erst während der kurzen Verzögerung bearbeitet: nicht neu laden, warten', async () => {
    const t = setup();
    t.ctrl.observe(A);
    t.ctrl.observe(B);
    t.ctrl.observe(B);
    t.setBusy(true);
    await t.c.advance(20_000);
    assert.equal(t.log.reloads, 0);
    assert.equal(t.log.notices.at(-1), 'waiting');
    t.setBusy(false);
    await t.c.advance(2_000);
    assert.equal(t.log.reloads, 1);
  });

  it('beim Warten zurück auf die alte Kennung (Rückkehr zur alten Version): Hinweis weg', async () => {
    const t = setup({ busy: true });
    t.ctrl.observe(A);
    t.ctrl.observe(B);
    t.ctrl.observe(B);
    t.ctrl.observe(A);
    t.setBusy(false);
    await t.c.advance(20_000);
    assert.equal(t.log.reloads, 0);
    assert.equal(t.ctrl.state().mode, 'idle');
  });

  it('Knopf „Neu laden“ im Hinweis lädt sofort (und merkt die Kennung)', async () => {
    const t = setup({ busy: true });
    t.ctrl.observe(A);
    t.ctrl.observe(B);
    t.ctrl.observe(B);
    t.ctrl.reloadNow();
    assert.equal(t.log.reloads, 1);
    assert.ok(JSON.parse(t.storage.getItem(W.GUARD_KEY)).builds[B] > 0);
  });
});

describe('Controller: keine Reload-Schleife', () => {
  it('für dieselbe Kennung binnen 10 min schon neu geladen: nur Hinweis, nie automatisch', async () => {
    const c0 = 1_000_000;
    const storage = memStorage({ [W.GUARD_KEY]: guard({ [B]: c0 - 5 * 60_000 }) });
    const t = setup({ storage });
    t.ctrl.observe(A);
    t.ctrl.observe(B);
    t.ctrl.observe(B);
    await t.c.advance(60_000);
    assert.equal(t.log.reloads, 0);
    assert.equal(t.log.notices.at(-1), 'manual');
    // auch weitere Abfragen ändern daran nichts
    t.ctrl.observe(B);
    await t.c.advance(60_000);
    assert.equal(t.log.reloads, 0);
  });

  it('nach 10 min darf dieselbe Kennung wieder (z. B. Update zurück und erneut)', async () => {
    const c0 = 1_000_000;
    const storage = memStorage({ [W.GUARD_KEY]: guard({ [B]: c0 - 11 * 60_000 }) });
    const t = setup({ storage });
    t.ctrl.observe(A);
    t.ctrl.observe(B);
    t.ctrl.observe(B);
    await t.c.advance(2_000);
    assert.equal(t.log.reloads, 1);
  });

  it('irgendein Neuladen in der letzten Minute: andere Kennung nur mit Hinweis (Wackeln A/B/C)', async () => {
    const c0 = 1_000_000;
    const storage = memStorage({ [W.GUARD_KEY]: guard({ [B]: c0 - 20_000 }) });
    const t = setup({ storage });
    t.ctrl.observe(B);
    t.ctrl.observe(C);
    t.ctrl.observe(C);
    await t.c.advance(5_000);
    assert.equal(t.log.reloads, 0);
    assert.equal(t.log.notices.at(-1), 'manual');
  });

  it('Speicher nicht nutzbar (privates Fenster): nie automatisch, nur Hinweis', async () => {
    const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    for (const storage of [null, broken]) {
      const t = setup({ storage });
      t.ctrl.observe(A);
      t.ctrl.observe(B);
      t.ctrl.observe(B);
      await t.c.advance(30_000);
      assert.equal(t.log.reloads, 0);
      assert.equal(t.log.notices.at(-1), 'manual');
    }
  });

  it('Codex 863eaeed: Sperre je Kennung bleibt, auch wenn dazwischen eine andere geladen wurde (B, C, B)', async () => {
    const c0 = 1_000_000;
    // B vor 2 min, C vor 61 s geladen — jetzt wieder B: nur Hinweis
    const storage = memStorage({ [W.GUARD_KEY]: JSON.stringify({ last: c0 - 61_000, builds: { [B]: c0 - 122_000, [C]: c0 - 61_000 } }) });
    const t = setup({ storage });
    t.ctrl.observe(C);
    t.ctrl.observe(B);
    t.ctrl.observe(B);
    await t.c.advance(30_000);
    assert.equal(t.log.reloads, 0);
    assert.equal(t.log.notices.at(-1), 'manual');
  });

  it('Sperr-Datensatz bleibt klein: alte Einträge (> 10 min) fallen weg, höchstens 20', async () => {
    const c0 = 1_000_000;
    const builds = { [C]: c0 - 30 * 60_000 };
    for (let i = 0; i < 30; i++) builds[('d' + String(i).padStart(11, '0'))] = c0 - 5 * 60_000 + i;
    const storage = memStorage({ [W.GUARD_KEY]: JSON.stringify({ last: c0 - 5 * 60_000, builds }) });
    const t = setup({ storage });
    t.ctrl.observe(A);
    t.ctrl.observe(B);
    t.ctrl.observe(B);
    await t.c.advance(2_000);
    assert.equal(t.log.reloads, 1);
    const rec = JSON.parse(storage.getItem(W.GUARD_KEY));
    assert.ok(!(C in rec.builds), 'abgelaufen');
    assert.ok(B in rec.builds);
    assert.ok(Object.keys(rec.builds).length <= 20, String(Object.keys(rec.builds).length));
  });

  it('Codex 863eaeed: Sperre lässt sich nicht speichern (Speicher voll): nicht automatisch, Knopf geht', async () => {
    const full = memStorage();
    full.setItem = () => { throw new Error('QuotaExceededError'); };
    const t = setup({ storage: full });
    t.ctrl.observe(A);
    t.ctrl.observe(B);
    t.ctrl.observe(B);
    await t.c.advance(30_000);
    assert.equal(t.log.reloads, 0);
    assert.equal(t.log.notices.at(-1), 'manual');
    t.ctrl.reloadNow();
    assert.equal(t.log.reloads, 1);
  });

  it('kaputter Speicherinhalt zählt als „noch nie neu geladen“', async () => {
    const t = setup({ storage: memStorage({ [W.GUARD_KEY]: '{kaputt' }) });
    t.ctrl.observe(A);
    t.ctrl.observe(B);
    t.ctrl.observe(B);
    await t.c.advance(2_000);
    assert.equal(t.log.reloads, 1);
  });

  it('nach dem Auslösen keine weiteren Aktionen in derselben Seite', async () => {
    const t = setup();
    t.ctrl.observe(A);
    t.ctrl.observe(B);
    t.ctrl.observe(B);
    await t.c.advance(2_000);
    t.ctrl.observe(C);
    t.ctrl.observe(C);
    t.ctrl.checkNow();
    await t.c.advance(60_000);
    assert.equal(t.log.reloads, 1);
    assert.equal(t.log.fetches, 0);
  });
});

describe('Controller: Prüfen bei Rückkehr in die Webapp', () => {
  it('checkNow fragt die Kennung ab und setzt den Ablauf in Gang', async () => {
    const t = setup({ fetchResults: [A, B, B] });
    t.ctrl.checkNow(); // Ausgangsstand
    await t.c.advance(0);
    assert.equal(t.ctrl.state().baseline, A);
    await t.c.advance(10_000);
    t.ctrl.checkNow(); // aus dem Hintergrund zurück
    await t.c.advance(0);
    assert.equal(t.ctrl.state().candidate, B);
    await t.c.advance(2_000 + 1_500);
    assert.equal(t.log.reloads, 1);
  });

  it('gedrosselt: höchstens ein Abruf je 5 s (visibilitychange + pageshow + focus zugleich)', async () => {
    const t = setup({ fetchResults: [A, A, A] });
    t.ctrl.checkNow();
    t.ctrl.checkNow();
    t.ctrl.checkNow();
    await t.c.advance(0);
    assert.equal(t.log.fetches, 1);
    await t.c.advance(5_000);
    t.ctrl.checkNow();
    await t.c.advance(0);
    assert.equal(t.log.fetches, 2);
  });
});

// --- „Wird bearbeitet“ aus dem DOM --------------------------------------

function el({ tag = 'DIV', type = '', hidden = false, ariaHidden = false, cls = [], visible = true, editable = false, parent = null } = {}) {
  const node = {
    tagName: tag, type, hidden, isContentEditable: editable, parentElement: parent,
    classList: { contains: (c) => cls.includes(c) },
    getAttribute: (n) => (n === 'aria-hidden' && ariaHidden ? 'true' : null),
    checkVisibility: () => visible,
    isConnected: true,
  };
  node.closest = (sel) => {
    for (let n = node; n; n = n.parentElement) {
      if (sel === '[hidden]' && n.hidden) return n;
      if (sel === '[aria-hidden="true"]' && n.getAttribute('aria-hidden') === 'true') return n;
    }
    return null;
  };
  return node;
}

function doc({ dialogs = [], active = null, bodyCls = [] } = {}) {
  return {
    activeElement: active,
    body: { classList: { contains: (c) => bodyCls.includes(c) } },
    querySelectorAll: () => dialogs,
  };
}

describe('Erkennung „wird bearbeitet“', () => {
  it('nichts offen, nichts im Fokus: frei', () => {
    const d = W.createBusyDetector({ doc: doc(), now: () => 0 });
    assert.equal(d.isBusy(), false);
  });

  it('offener Dialog (aria-modal, dv-modal, Einmal-Abfahrt) zählt, versteckter nicht', () => {
    const now = () => 0;
    assert.equal(W.createBusyDetector({ doc: doc({ dialogs: [el()] }), now }).isBusy(), true);
    assert.equal(W.createBusyDetector({ doc: doc({ dialogs: [el({ hidden: true })] }), now }).isBusy(), false);
    assert.equal(W.createBusyDetector({ doc: doc({ dialogs: [el({ visible: false })] }), now }).isBusy(), false);
    assert.equal(W.createBusyDetector({ doc: doc({ dialogs: [el({ ariaHidden: true })] }), now }).isBusy(), false);
    const hiddenParent = el({ hidden: true });
    assert.equal(W.createBusyDetector({ doc: doc({ dialogs: [el({ parent: hiddenParent })] }), now }).isBusy(), false);
  });

  it('Seitenleiste (.dv-drawer) nur mit is-open', () => {
    const now = () => 0;
    assert.equal(W.createBusyDetector({ doc: doc({ dialogs: [el({ cls: ['dv-drawer'] })] }), now }).isBusy(), false);
    assert.equal(W.createBusyDetector({ doc: doc({ dialogs: [el({ cls: ['dv-drawer', 'is-open'] })] }), now }).isBusy(), true);
  });

  it('Integrationen ab 1000 px: Einstellungen in der Mitte (dv-drawer--inline) sind Seiteninhalt, kein Dialog', () => {
    // Dort ist immer eine Integration gewählt — sonst lüde die Seite nie automatisch.
    const inline = el({ cls: ['dv-drawer', 'dv-drawer--inline', 'is-open'] });
    assert.equal(W.createBusyDetector({ doc: doc({ dialogs: [inline] }), now: () => 0 }).isBusy(), false);
  });

  it('Fokus in einem Eingabefeld zählt; Knopf/Haken/Schieber im Fokus nicht', () => {
    const now = () => 0;
    for (const a of [el({ tag: 'INPUT', type: 'text' }), el({ tag: 'INPUT', type: 'number' }), el({ tag: 'INPUT', type: 'time' }), el({ tag: 'TEXTAREA' }), el({ tag: 'SELECT' }), el({ editable: true })]) {
      assert.equal(W.createBusyDetector({ doc: doc({ active: a }), now }).isBusy(), true, a.tagName + a.type);
    }
    for (const a of [el({ tag: 'BUTTON' }), el({ tag: 'INPUT', type: 'checkbox' }), el({ tag: 'INPUT', type: 'button' }), el({ tag: 'BODY' })]) {
      assert.equal(W.createBusyDetector({ doc: doc({ active: a }), now }).isBusy(), false, a.tagName + a.type);
    }
  });

  it('Einstellungen mit ungespeicherten Änderungen (body.has-changes)', () => {
    assert.equal(W.createBusyDetector({ doc: doc({ bodyCls: ['has-changes'] }), now: () => 0 }).isBusy(), true);
  });

  it('Seiten melden eigene Entwürfe (E-Auto-Kachel, Wochenplan)', () => {
    const d = W.createBusyDetector({ doc: doc(), now: () => 0 });
    let dirty = false;
    d.registerUnsavedCheck(() => dirty);
    d.registerUnsavedCheck(() => { throw new Error('kaputt'); }); // stört nicht
    assert.equal(d.isBusy(), false);
    dirty = true;
    assert.equal(d.isBusy(), true);
  });

  it('Eingabe ohne anschließendes Speichern zählt bis zu 15 min; Speichern (Schreibaufruf) gibt frei', () => {
    let t = 0;
    const d = W.createBusyDetector({ doc: doc(), now: () => t });
    d.noteEdit(el({ tag: 'INPUT', type: 'number' }));
    t = 60_000;
    assert.equal(d.isBusy(), true);
    d.noteWrite('/api/config');
    assert.equal(d.isBusy(), false);
    d.noteEdit(el({ tag: 'INPUT', type: 'checkbox' }));
    t += 14 * 60_000;
    assert.equal(d.isBusy(), true);
    t += 2 * 60_000;
    assert.equal(d.isBusy(), false, 'nach 15 min ohne Eingabe nicht mehr');
  });

  it('Codex 863eaeed: Vorschau-/Test-/Aktualisieren-Aufrufe sind kein Speichern', () => {
    const t = 0;
    const d = W.createBusyDetector({ doc: doc(), now: () => t });
    d.noteEdit(el({ tag: 'INPUT', type: 'time' }));
    for (const u of ['/api/ev/preview', '/api/tariff-provider/test', '/api/luox/test?x=1', '/api/epex/refresh', '/api/pv-strings/backfill', '/api/integrations/notifications/test']) {
      d.noteWrite(u);
      assert.equal(d.isBusy(), true, u);
    }
    d.noteWrite('/api/integrations/evcc');
    assert.equal(d.isBusy(), false);
    assert.equal(W.isSavingWrite('/api/ev'), true);
    assert.equal(W.isSavingWrite('http://box:8080/api/ev/preview'), false);
  });

  it('Knöpfe lösen keine Bearbeitung aus', () => {
    const d = W.createBusyDetector({ doc: doc(), now: () => 0 });
    d.noteEdit(el({ tag: 'BUTTON' }));
    d.noteEdit(null);
    assert.equal(d.isBusy(), false);
  });
});

describe('Einbindung', () => {
  const pages = ['index.html', 'family.html', 'integrations.html', 'settings.html', 'history.html', 'explorer.html'];
  it('jede Bedienseite lädt build-watch.js direkt nach common.js', () => {
    for (const p of pages) {
      const html = fs.readFileSync(path.join(PUB, p), 'utf8');
      const i = html.indexOf('src="/common.js');
      const j = html.indexOf('src="/build-watch.js');
      assert.ok(i > 0 && j > i, p);
      assert.ok(!html.slice(i, j).includes('<script src="/app.js'), p);
    }
  });

  it('common.js reicht jede API-Antwort weiter (Kennung + Schreibaufrufe)', () => {
    const common = fs.readFileSync(path.join(PUB, 'common.js'), 'utf8');
    assert.match(common, /x-dvhub-build/);
    assert.match(common, /onApiResponse/);
  });

  it('Codex 863eaeed: MQTT-Kachel-Editor meldet ungespeicherte Änderungen (auch Löschen, Symbol, Farbe)', () => {
    const intg = fs.readFileSync(path.join(PUB, 'integrations.js'), 'utf8');
    assert.match(intg, /registerUnsavedCheck\(function \(\) \{[\s\S]{0,200}mteCollect\(\)/);
    assert.match(intg, /mteSavedJson = JSON\.stringify\(mteCollect\(\)\)/);
  });

  it('E-Auto-Kachel meldet ihren Entwurf', () => {
    const tile = fs.readFileSync(path.join(PUB, 'ev-tile.js'), 'utf8');
    assert.match(tile, /registerUnsavedCheck/);
  });

  it('Hinweis: role=status, Stil in dvhub-app.css mit Design-Tokens', () => {
    assert.match(src, /role', 'status'|role="status"/);
    const css = fs.readFileSync(path.join(PUB, 'dvhub-app.css'), 'utf8');
    assert.match(css, /\.dv-build-notice\s*\{[^}]*var\(--/);
  });
});
