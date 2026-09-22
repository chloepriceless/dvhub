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
  const evccPct = num(lp?.vehicleSocPct);
  if (evccPct !== null && evccPct >= 0 && evccPct <= 100) return { pct: evccPct, source: 'evcc' };

  return null;
}
