// services/tariff-provider/tibber-client.js — Viertelstundenpreise aus der
// offiziellen Tibber-API (developer.tibber.com, persönlicher Zugangsschlüssel).
//
// Abfrage wie evcc (meter/tibber/types.go): priceInfo(resolution: QUARTER_HOURLY)
// mit today/tomorrow; `total` ist der Endpreis in der Währung je kWh.
// Morgen erscheint gegen 13 Uhr (nach der Day-Ahead-Auktion).

import { TariffProviderError, postJson, pointsToSlots } from './common.js';

export const TIBBER_API_URL = 'https://api.tibber.com/v1-beta/gql';

export const TIBBER_PRICE_QUERY = `query DvhubTibberPrices {
  viewer {
    homes {
      id
      appNickname
      currentSubscription {
        status
        priceInfo(resolution: QUARTER_HOURLY) {
          today { startsAt total energy tax currency }
          tomorrow { startsAt total energy tax currency }
        }
      }
    }
  }
}`;

function pickHome(homes, homeId) {
  if (homeId) {
    const match = homes.find((h) => h?.id === homeId);
    if (!match) throw new TariffProviderError('no_contract', 'Das eingetragene Tibber-Zuhause (Home-ID) gibt es in diesem Konto nicht.');
    return match;
  }
  const withPrices = homes.filter((h) => {
    const pi = h?.currentSubscription?.priceInfo;
    return (pi?.today?.length || 0) + (pi?.tomorrow?.length || 0) > 0;
  });
  return withPrices[0] || homes.find((h) => h?.currentSubscription) || homes[0] || null;
}

/**
 * @param {{token:string, homeId?:string, fetchImpl?:Function}} opts
 * @returns {Promise<{provider:'tibber', account:{homeId:string, label:string|null, status:string|null}, slots:Array}>}
 */
export async function fetchTibberPrices({ token, homeId = '', fetchImpl = globalThis.fetch } = {}) {
  if (!token) throw new TariffProviderError('auth', 'Kein Tibber-Zugangsschlüssel eingetragen.');
  const { status, json } = await postJson(fetchImpl, TIBBER_API_URL, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'DVhub (https://dvhub.online)'
    },
    body: JSON.stringify({ query: TIBBER_PRICE_QUERY })
  });
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  const unauth = status === 401 || status === 403
    || errors.some((e) => /UNAUTHENTICATED|unauthori[sz]ed|invalid token/i.test(`${e?.extensions?.code || ''} ${e?.message || ''}`));
  if (unauth) throw new TariffProviderError('auth', 'Tibber lehnt den Zugangsschlüssel ab.');
  if (status >= 500) throw new TariffProviderError('api', `Tibber antwortet mit HTTP ${status}.`);
  if (!json?.data && errors.length) throw new TariffProviderError('api', `Tibber-Fehler: ${String(errors[0]?.message || '').slice(0, 200)}`);
  if (status >= 400) throw new TariffProviderError('api', `Tibber antwortet mit HTTP ${status}.`);

  const homes = Array.isArray(json?.data?.viewer?.homes) ? json.data.viewer.homes : null;
  if (!homes) throw new TariffProviderError('format', 'Unerwartete Antwort von Tibber.');
  if (!homes.length) throw new TariffProviderError('no_contract', 'Im Tibber-Konto ist kein Zuhause angelegt.');
  const home = pickHome(homes, homeId);
  const sub = home?.currentSubscription;
  if (!sub) throw new TariffProviderError('no_contract', 'Kein aktiver Tibber-Stromvertrag in diesem Konto.');

  const raw = [...(sub.priceInfo?.today || []), ...(sub.priceInfo?.tomorrow || [])].filter(Boolean);
  const foreign = raw.find((p) => p.currency && p.currency !== 'EUR');
  if (foreign) throw new TariffProviderError('format', `Tibber liefert Preise in ${foreign.currency}; DVhub rechnet nur in Euro.`);
  const slots = pointsToSlots(raw
    .filter((p) => p.startsAt && Number.isFinite(Number(p.total)))
    .map((p) => ({ ts: p.startsAt, ctKwh: Math.round(Number(p.total) * 100 * 10000) / 10000 })));

  return {
    provider: 'tibber',
    account: { homeId: home.id || null, label: home.appNickname || null, status: sub.status || null },
    slots
  };
}
