// services/optimizer/eos-replan-after-save.js — Neuplan nach dem Speichern erst,
// wenn der Abgleich mit EOS (Prognose-Push mit Steuerzeitraum, Config-Sync mit
// Akku, Auto und Geräten) durch ist: ctx.eosAfterSave, gesetzt von
// ctx.saveAndApplyConfig (server.js). Sonst rechnete der angestoßene Lauf mit
// altem Stand (Gegenprüfungen ae4e76f6, a25589cc). Ein fehlgeschlagener
// Abgleich hält den Neuplan nicht auf.

/**
 * @param {object} ctx     { eosAfterSave?: Promise, optimizerService?: { requestEosReplan } }
 * @param {string} reason  Grund im Log (config, ev_config, devices …)
 * @returns {Promise<void>}
 */
export function requestEosReplanAfterSave(ctx, reason = 'config') {
  const run = () => { ctx?.optimizerService?.requestEosReplan?.(reason); };
  const pending = ctx?.eosAfterSave;
  if (pending && typeof pending.then === 'function') return pending.then(run, run);
  run();
  return Promise.resolve();
}
