// dv-profile-check.js -- Passt eine Anfrage des Direktvermarkters zum Profil?
//
// Christin 2026-10-20: Was der Direktvermarkter schickt und nicht zum gewählten
// Profil gehört, wurde bisher still ignoriert (z. B. ein Zwischenwert auf
// Adresse 0 im Plexlog-Profil — die Anlage hätte voll weiter eingespeist).
// Jetzt wird es gemeldet (modbus-server.js → Protokoll + Systemwarnung).
//
// Plexlog (abgeschaut am echten LUOX-Verkehr Mai–Okt 2026):
//   Lesen  FC4 0–6 (offizielle Input-Tabelle), FC3 0–4 (gemeinsamer Bereich)
//   Aus    Adresse 0 = 0,0      · Adresse 3 = 1
//   An     Adresse 0 = 255,255 oder FFFF,FFFF · Adresse 3 = 0
// LUOX/Lumenaza (Tabelle 02.06.2026):
//   Lesen  FC4 0–6 (Input), FC3 2–4 (Holding)
//   Holding 2 = 0–100 % · Holding 3–4 = Watchdog (beliebiger Wert)

const READ_WINDOWS = Object.freeze({
  plexlog: { 4: [0, 7], 3: [0, 5] },
  luox: { 4: [0, 7], 3: [2, 5] },
});

function inWindow(win, addr, qty) {
  return win && addr >= win[0] && addr + qty <= win[1];
}

const fmt = (values) => values.join(', ');

function plexlogWrite(addr, values) {
  if (addr === 0 && values.length === 2) {
    const [a, b] = values;
    if (a === b && (a === 0 || a === 255 || a === 0xffff)) return null;
    return `Adresse 0 mit Werten ${fmt(values)} (bekannt: 0, 0 = aus · 255, 255 = an)`;
  }
  if (addr === 3 && values.length === 1 && (values[0] === 0 || values[0] === 1)) return null;
  return `Adresse ${addr} mit ${values.length === 1 ? 'Wert' : 'Werten'} ${fmt(values)}`;
}

function luoxWrite(addr, values) {
  for (let i = 0; i < values.length; i++) {
    const a = addr + i;
    if (a === 2) {
      if (values[i] > 100) return `Vorgabe ${values[i]} % auf Holding 2 (erlaubt 0–100)`;
    } else if (a !== 3 && a !== 4) {
      return `Adresse ${a} mit Wert ${values[i]} (Tabelle: nur Holding 2–4)`;
    }
  }
  return null;
}

/**
 * @param {'plexlog'|'luox'} profile
 * @param {{ fc: number, addr?: number, qty?: number, values?: number[] }} req
 * @returns {string|null} Beschreibung, was nicht passt — null = passt
 */
export function classifyDvRequest(profile, { fc, addr = 0, qty = 1, values = [] }) {
  const p = profile === 'luox' ? 'luox' : 'plexlog';
  if (fc === 3 || fc === 4) {
    if (inWindow(READ_WINDOWS[p][fc], addr, qty)) return null;
    return `Lesen FC${fc} ab Adresse ${addr}, ${qty} Register (außerhalb der Belegung)`;
  }
  if (fc === 6 || fc === 16) {
    const vals = values.map((v) => Number(v) & 0xffff);
    return p === 'luox' ? luoxWrite(addr, vals) : plexlogWrite(addr, vals);
  }
  return `Funktionscode ${fc} (nicht vorgesehen)`;
}
