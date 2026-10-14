// test/helpers/settings-page.js — die Einstellungsseite (public/settings.js) im
// Test laden, mit einem kleinen Ersatz-Browser. Er verhält sich an den Stellen
// wie ein echter, an denen Werte verloren gehen: Auswahlfeld mit unbekanntem
// Wert → '', Zahlenfeld mit Text → ''. Ereignis-Handler werden gemerkt
// (el.fire('input')).

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(child) { this.children.push(child); return child; },
    listeners: {},
    setAttribute() {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    fire(type) { for (const fn of this.listeners[type] || []) fn({ target: this }); },
  };
  if (el.tagName === 'SELECT') {
    let set;
    Object.defineProperty(el, 'value', {
      get() {
        const opts = el.children.filter((c) => c.tagName === 'OPTION');
        if (set === undefined) return opts[0]?.value ?? '';
        return opts.some((o) => o.value === set) ? set : '';
      },
      set(v) { set = String(v); },
    });
    Object.defineProperty(el, 'innerHTML', { set() { el.children = []; } });
  }
  if (el.tagName === 'INPUT') {
    let raw = '';
    el.type = 'text';
    Object.defineProperty(el, 'value', {
      get() {
        if (el.type === 'number' && raw !== '' && !Number.isFinite(Number(raw))) return '';
        if (el.type === 'time' && raw !== '' && !/^\d{2}:\d{2}(:\d{2})?$/.test(raw)) return '';
        return raw;
      },
      set(v) { raw = String(v); },
    });
  }
  return el;
}

export function loadSettingsPage() {
  const settingsPath = fileURLToPath(new URL('../../public/settings.js', import.meta.url));
  const context = vm.createContext({
    console,
    window: {
      DVhubCommon: {
        apiFetch: () => new Promise(() => {}),
        buildApiUrl: (p) => p,
        escapeHtml: (v) => String(v ?? ''),
        setStoredApiToken() {},
      },
      addEventListener() {},
      setTimeout() {},
    },
  });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(settingsPath, 'utf8'), context, { filename: path.basename(settingsPath) });
  // Erst nach dem Laden: der Start-Code der Seite soll nicht laufen.
  const inputs = new Map();
  context.document = {
    createElement: makeElement,
    getElementById: (id) => inputs.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { classList: { toggle() {}, add() {}, remove() {} } },
  };
  return { context, inputs };
}

