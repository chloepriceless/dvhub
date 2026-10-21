// test/settings-location-picker.test.js — „Auf Karte wählen“ muss den Standort
// in die Felder Breiten-/Längengrad übernehmen (Feldfall 21.10.2026).
//
// Seit eac147f trägt auch die Zeile eines Feldes data-path; sie steht im DOM
// vor dem Eingabefeld. Der Picker suchte per querySelector('[data-path=…]')
// und traf die Zeile — die Felder blieben leer, die Karte öffnete immer in
// Deutschland-Mitte. Außerdem löste er nur 'input' aus, die Seite hört aber
// auf 'change' (Entwurf + Speichern-Leiste).
//
// Der Ersatz-Browser hier hat — anders als helpers/settings-page.js — einen
// echten Baum: querySelector findet in Dokument-Reihenfolge, Ereignisse
// steigen auf. Leaflet ist eine Attrappe.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { getConfigDefinition, normalizeConfigInput } from '../config-model.js';

class FakeEvent { constructor(type, opts = {}) { this.type = type; this.bubbles = !!opts.bubbles; } }

function makeDom() {
  const all = (root) => { const out = []; const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } }; walk(root); return out; };
  const matches = (el, sel) => {
    const m = /^([a-z]*)(?:\[([\w-]+)(\*?=)"([^"]*)"\])?(?:\.([\w-]+))?(?:#([\w-]+))?$/.exec(sel);
    if (!m) return false;
    const [, tag, attr, op, val, cls, id] = m;
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    if (cls && !String(el.className || '').split(/\s+/).includes(cls)) return false;
    if (id && el.id !== id) return false;
    if (attr) {
      const v = attr.startsWith('data-')
        ? el.dataset[attr.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())]
        : el[attr];
      if (v === undefined) return false;
      if (op === '=' && String(v) !== val) return false;
      if (op === '*=' && !String(v).includes(val)) return false;
    }
    return true;
  };
  function el(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [], parentNode: null, dataset: {}, style: {}, listeners: {}, className: '', id: '', disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute(k, v) { if (k === 'disabled') this.disabled = true; else this[k] = v; },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); this.parentNode = null; },
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      dispatchEvent(ev) {
        ev.target = this;
        for (let n = this; n; n = ev.bubbles ? n.parentNode : null) for (const fn of n.listeners[ev.type] || []) fn(ev);
        return true;
      },
      click() { if (!this.disabled) this.dispatchEvent(new FakeEvent('click', { bubbles: true })); },
      querySelector(sel) { return all(this).find((c) => matches(c, sel)) ?? null; },
      querySelectorAll(sel) { return all(this).filter((c) => matches(c, sel)); },
      value: '',
    };
    // Grobes innerHTML: jedes Start-Tag wird ein flaches Kind mit id/class/disabled.
    Object.defineProperty(node, 'innerHTML', {
      set(html) {
        node.children = [];
        for (const [, t, attrs] of String(html).matchAll(/<([a-z]+)([^>]*)>/g)) {
          const child = el(t);
          child.id = /\bid="([^"]*)"/.exec(attrs)?.[1] || '';
          child.className = /\bclass="([^"]*)"/.exec(attrs)?.[1] || '';
          child.disabled = /\sdisabled\b/.test(attrs);
          node.appendChild(child);
        }
      },
    });
    return node;
  }
  const body = el('body');
  const bodyClasses = new Set();
  body.classList = { add: (c) => bodyClasses.add(c), remove: (c) => bodyClasses.delete(c), toggle: (c, on) => (on ? bodyClasses.add(c) : bodyClasses.delete(c)), contains: (c) => bodyClasses.has(c) };
  const head = el('head');
  const document = {
    createElement: el,
    body, head,
    getElementById: (id) => all(body).find((n) => n.id === id) ?? null,
    querySelector: (sel) => body.querySelector(sel) ?? head.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
  };
  return { document, bodyClasses };
}

function fakeLeaflet() {
  const handlers = {};
  const state = { view: null, marker: null };
  const marker = {
    latlng: null,
    on(type, fn) { handlers[`marker:${type}`] = fn; return this; },
    addTo() { return this; },
    getLatLng() { return this.latlng; },
    setLatLng(ll) { this.latlng = ll; return this; },
  };
  const L = {
    map: () => ({
      setView(center, zoom) { state.view = { center, zoom }; return this; },
      on(type, fn) { handlers[`map:${type}`] = fn; return this; },
      invalidateSize() {},
    }),
    tileLayer: () => ({ addTo() { return this; } }),
    marker: (ll) => { marker.latlng = { lat: ll[0], lng: ll[1] }; state.marker = marker; return marker; },
  };
  return { L, state, clickMap: (lat, lng) => handlers['map:click']({ latlng: { lat, lng } }) };
}

function loadPage(config) {
  const settingsPath = fileURLToPath(new URL('../public/settings.js', import.meta.url));
  const context = vm.createContext({
    console, Event: FakeEvent,
    window: { DVhubCommon: { apiFetch: () => new Promise(() => {}), buildApiUrl: (p) => p, escapeHtml: (v) => String(v ?? ''), setStoredApiToken() {} }, addEventListener() {}, setTimeout() {} },
    setTimeout() {},
  });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(settingsPath, 'utf8'), context, { filename: path.basename(settingsPath) });
  const { document, bodyClasses } = makeDom();
  context.document = document;
  const leaflet = fakeLeaflet();
  context.L = leaflet.L;
  const normalized = normalizeConfigInput(JSON.parse(JSON.stringify(config)));
  context.__payload = { config, effectiveConfig: normalized.effectiveConfig, definition: getConfigDefinition(), meta: {} };
  vm.runInContext('loadConfigPayloadState(__payload)', context);
  // Das Grid wie in initSettingsPage: 'change' → Entwurf + Speichern-Leiste.
  const grid = document.createElement('div');
  grid.className = 'sa-area-grid';
  document.body.appendChild(grid);
  const changes = [];
  grid.addEventListener('change', (event) => {
    if (!event.target?.dataset?.path) return;
    changes.push(event.target.dataset.path);
    context.syncRenderedFieldsToDraft();
    context.updateSaveBar();
  });
  return { context, document, grid, changes, bodyClasses, leaflet };
}

function renderGroup(page, groupId) {
  page.context.__groupId = groupId;
  vm.runInContext(`renderGroupedCardsOb(document.querySelector('.sa-area-grid'),
    { sections: [{ id: 't', groups: [collectSettingsGroupsById().get(__groupId)] }] }, 't')`, page.context);
  return page.grid.querySelectorAll('button').find((b) => String(b.textContent).includes('Auf Karte'));
}

// Werte aus dem vm-Kontext haben fremde Prototypen; deepEqual (strict) vergleicht die mit.
const plain = (v) => JSON.parse(JSON.stringify(v));
const input = (page, p) => page.grid.querySelector(`input[data-path="${p}"]`);

test('Karten-Picker: Übernehmen schreibt in die Eingabefelder, Entwurf und Speichern-Leiste ziehen nach', () => {
  const page = loadPage({ manufacturer: 'victron', forecast: { location: { latitude: 0, longitude: 0 } } });
  const mapBtn = renderGroup(page, 'location');
  assert.ok(mapBtn, 'Gruppe Standort hat einen Kartenknopf');
  // Die Zeile trägt denselben data-path und steht vor dem Eingabefeld — genau die Falle.
  const first = page.grid.querySelector('[data-path="forecast.location.latitude"]');
  assert.notEqual(first.tagName, 'INPUT', 'Voraussetzung: [data-path] trifft zuerst die Zeile');

  mapBtn.click();
  assert.deepEqual(plain(page.leaflet.state.view), { center: [51, 10], zoom: 6 }, '0/0 gilt als ungesetzt: Übersicht Deutschland');
  const apply = page.document.getElementById('location-picker-apply');
  assert.equal(apply.disabled, true, 'ohne Standort erst nach einem Klick auf die Karte übernehmbar');

  page.leaflet.clickMap(48.125611, 9.432794);
  assert.equal(apply.disabled, false);
  apply.click();

  assert.equal(input(page, 'forecast.location.latitude').value, '48.125611');
  assert.equal(input(page, 'forecast.location.longitude').value, '9.432794');
  assert.deepEqual([...new Set(page.changes)], ['forecast.location.latitude', 'forecast.location.longitude']);
  const draft = vm.runInContext('currentDraftConfig', page.context);
  assert.equal(draft.forecast.location.latitude, 48.125611);
  assert.equal(draft.forecast.location.longitude, 9.432794);
  assert.equal(page.bodyClasses.has('has-changes'), true, 'Speichern-Leiste sichtbar');
  assert.equal(page.document.getElementById('location-picker-apply'), null, 'Fenster geschlossen');
});

test('Karten-Picker: öffnet am eingetragenen Standort und normalisiert den Längengrad', () => {
  const page = loadPage({ manufacturer: 'victron', forecast: { location: { latitude: 52.52, longitude: 13.405 } } });
  renderGroup(page, 'location').click();
  assert.deepEqual(plain(page.leaflet.state.view), { center: [52.52, 13.405], zoom: 15 });
  assert.equal(page.document.getElementById('location-picker-apply').disabled, false);
  page.leaflet.clickMap(52.5, 13.4 + 360); // nach einer Weltumrundung
  page.document.getElementById('location-picker-apply').click();
  assert.equal(input(page, 'forecast.location.longitude').value, '13.400000');
});

test('Karten-Picker: Kleinanlagen-Automatik trifft ihre eigenen Felder', () => {
  const page = loadPage({ manufacturer: 'victron', schedule: { smallMarketAutomation: { location: { latitude: 50.1, longitude: 8.7 } } } });
  const btn = renderGroup(page, 'smaLocation');
  assert.ok(btn, 'Gruppe Automatik-Standort hat einen Kartenknopf');
  btn.click();
  assert.deepEqual(plain(page.leaflet.state.view.center), [50.1, 8.7]);
  page.leaflet.clickMap(50.2, 8.8);
  page.document.getElementById('location-picker-apply').click();
  assert.equal(input(page, 'schedule.smallMarketAutomation.location.latitude').value, '50.200000');
  const draft = vm.runInContext('currentDraftConfig', page.context);
  assert.equal(draft.schedule.smallMarketAutomation.location.longitude, 8.8);
});
