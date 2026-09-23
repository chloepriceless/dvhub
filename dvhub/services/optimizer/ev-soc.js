/**
 * Ladestand des E-Autos fuer EOS.
 *
 * EOS braucht fuer ein angemeldetes Fahrzeug einen Start-SoC. 0.3 rechnete
 * ohne ihn stillschweigend mit 0; ab 0.4 bricht der GANZE Lauf ab ("Fresh SoC
 * missing for ev11") — auch der Hausakku bekommt dann keinen Plan (prod
 * 2026-09-23). DVhub hat den Wert bisher nie geliefert: `state.victron.evSocPct`
 * setzt niemand.
 *
 * Quellen, in dieser Reihenfolge:
 *   1. TeslaMate (`batteryLevel`) — sendet nur bei Aenderung, der letzte Wert
 *      gilt (ein schlafendes Auto aendert seinen SoC nicht) und wird beim
 *      Start aus der DB vorgeladen.
 *   2. evcc — SoC am gesteuerten Ladepunkt (nur wenn ein Fahrzeug erkannt ist).
 *
 * @returns {{ pct: number, source: string } | null}
 */
export function resolveEvSocPct(ctx) {
  const num = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

  const tesla = ctx?.teslamateService?.getState?.();
  const teslaPct = num(tesla?.batteryLevel);
  if (teslaPct !== null && teslaPct >= 0 && teslaPct <= 100) return { pct: teslaPct, source: 'teslamate' };

  const lpId = Number(ctx?.getCfg?.()?.optimizer?.evEvccLoadpoint) || 1;
  const lps = ctx?.evccIntegration?.getLoadpoints?.() || [];
  const lp = lps.find((l) => l.id === lpId);
  // Ohne angestecktes Fahrzeug meldet evcc vehicleSoc 0 (prod 2026-09-23) —
  // das waere fuer EOS ein leerer Akku und ein voller Ladeplan.
  const evccPct = lp?.connected === true ? num(lp?.vehicleSocPct) : null;
  if (evccPct !== null && evccPct >= 0 && evccPct <= 100) return { pct: evccPct, source: 'evcc' };

  return null;
}

/**
 * Steckt das Auto am gesteuerten Ladepunkt? Quelle: evcc (`connected`).
 * @returns {boolean|null} null = unbekannt (evcc nicht erreichbar/kein Ladepunkt)
 */
export function resolveEvPlugged(ctx) {
  const lpId = Number(ctx?.getCfg?.()?.optimizer?.evEvccLoadpoint) || 1;
  const lps = ctx?.evccIntegration?.getLoadpoints?.() || [];
  const lp = lps.find((l) => l.id === lpId);
  if (!lp) return null;
  return lp.connected === true;
}

/**
 * Entprellt den Steck-Zustand: ein Wechsel zaehlt erst, wenn er `stableTicks`
 * Abfragen in Folge gleich bleibt (evcc meldet beim Anstecken/Abziehen kurz
 * wechselnde Werte; jeder Wechsel kostet einen EOS-Neuplan). Die allererste
 * Beobachtung setzt nur den Ausgangszustand — beim DVhub-Start meldet der
 * regulaere Abgleich das Auto ohnehin passend an.
 */
export function createEvPlugTracker({ stableTicks = 2 } = {}) {
  let stable;          // undefined = noch keine Beobachtung
  let candidate;
  let count = 0;
  return {
    update(value) {
      if (stable === undefined) { stable = value; return { changed: false, stable }; }
      if (value === stable) { candidate = undefined; count = 0; return { changed: false, stable }; }
      if (value !== candidate) { candidate = value; count = 1; } else count += 1;
      if (count >= stableTicks) {
        const from = stable;
        stable = value; candidate = undefined; count = 0;
        return { changed: true, from, stable };
      }
      return { changed: false, stable };
    },
    get stable() { return stable; }
  };
}
