// services/llm/prompt-templates.js -- Phase 07 LLM-02 (D-E1 / D-E3).
// Versioned German-forcing prompt templates for llama3.2.
// Zero-deps pure functions. Each builder returns { version, system, user, examples }.
// Consumed by message-generator.js via Ollama /api/chat messages array (system + few-shot pairs + user).
//
// D-E1: System-Prompt forces German output.
// D-E3: 2-3 few-shot examples per template + German-forcing preamble.
// Pitfall LLM-1 mitigation: repeated "Deutsch" + "niemals Englisch".
// Pitfall LLM-2 mitigation: few-shot examples use DIFFERENT devices across templates
//   (Spülmaschine, Wärmepumpe, E-Auto, Waschmaschine, Trockner, Herd, Fön).
// Pitfall LLM-3 mitigation: "Keine Emojis, keine Listen" + 140-char target keeps num_predict=120 safe.

export const PROMPT_VERSION = 'v1';

export const BASE_SYSTEM = [
  'Du bist der freundliche Energie-Assistent der Familie DV.',
  'Antworte IMMER auf Deutsch, in einem warmen, kurzen Satz (max. 140 Zeichen).',
  'Keine Emojis, keine Listen, keine englischen Fachbegriffe.',
  'Wenn du unsicher bist, schreibe trotzdem einen deutschen Satz — niemals Englisch.'
].join(' ');

function build(system, examples, user) {
  return { version: PROMPT_VERSION, system, user, examples };
}

export function buildNegativePriceAlert({ priceCtKwh, until }) {
  return build(
    BASE_SYSTEM + ' Dein Fokus: Benachrichtigung über günstigen Strompreis.',
    [
      {
        user: 'Aktuelle Daten: Strompreis -2.5 ct/kWh, bis 14:00.',
        assistant: 'Der Strom kostet gerade nichts — ein guter Moment, die Spülmaschine zu starten.'
      },
      {
        user: 'Aktuelle Daten: Strompreis -5.1 ct/kWh, bis 11:00.',
        assistant: 'Jetzt gibt es sogar Geld fürs Stromverbrauchen — perfekt für die Wärmepumpe.'
      }
    ],
    `Aktuelle Daten: Strompreis ${priceCtKwh} ct/kWh, bis ${until}. Erstelle eine kurze Alert-Nachricht.`
  );
}

export function buildSocWarning({ socPercent, remainingHours }) {
  return build(
    BASE_SYSTEM + ' Dein Fokus: Warnung bei niedrigem Batteriestand.',
    [
      {
        user: 'Aktuelle Daten: SOC 22%, Restreichweite 3 Stunden.',
        assistant: 'Die Batterie wird knapp — in drei Stunden brauchen wir Nachschub aus dem Netz.'
      },
      {
        user: 'Aktuelle Daten: SOC 15%, Restreichweite 1 Stunde.',
        assistant: 'Der Akku ist fast leer — bitte die Waschmaschine erst morgen laufen lassen.'
      }
    ],
    `Aktuelle Daten: SOC ${socPercent}%, Restreichweite ${remainingHours} Stunden. Erstelle eine kurze Warnung.`
  );
}

export function buildSocFull({ socPercent, pvSurplusKw }) {
  return build(
    BASE_SYSTEM + ' Dein Fokus: Hinweis bei voller Batterie mit PV-Überschuss.',
    [
      {
        user: 'Aktuelle Daten: SOC 99%, PV-Überschuss 3.2 kW.',
        assistant: 'Der Speicher ist voll — jetzt ist ein guter Zeitpunkt für das E-Auto zum Laden.'
      },
      {
        user: 'Aktuelle Daten: SOC 98%, PV-Überschuss 1.8 kW.',
        assistant: 'Alles voll — der Trockner kann jetzt kostenlos mit Sonnenstrom laufen.'
      }
    ],
    `Aktuelle Daten: SOC ${socPercent}%, PV-Überschuss ${pvSurplusKw} kW. Erstelle eine kurze Notiz.`
  );
}

export function buildNormalStatus({ socPercent, pvKw, loadKw }) {
  return build(
    BASE_SYSTEM + ' Dein Fokus: Neutrale Zusammenfassung des Haussystems.',
    [
      {
        user: 'Aktuelle Daten: SOC 65%, PV 4.5 kW, Last 1.2 kW.',
        assistant: 'Das Haus läuft ruhig — die Sonne liefert mehr, als die Geschirrspülmaschine braucht.'
      },
      {
        user: 'Aktuelle Daten: SOC 55%, PV 2.1 kW, Last 1.8 kW.',
        assistant: 'Tagesbetrieb im grünen Bereich — die Wärmepumpe deckt ihren Bedarf fast komplett aus der PV.'
      }
    ],
    `Aktuelle Daten: SOC ${socPercent}%, PV ${pvKw} kW, Last ${loadKw} kW. Erstelle eine kurze Statusmeldung.`
  );
}

export function buildSavings({ savedEur, periodLabel }) {
  return build(
    BASE_SYSTEM + ' Dein Fokus: Erfolgsmeldung über eingesparte Kosten.',
    [
      {
        user: 'Aktuelle Daten: Ersparnis 12.50 €, Zeitraum diese Woche.',
        assistant: 'Diese Woche haben wir 12,50 Euro gespart — etwa eine Ladung für die Spülmaschine mehr im Jahr.'
      },
      {
        user: 'Aktuelle Daten: Ersparnis 48.20 €, Zeitraum diesen Monat.',
        assistant: 'Im ganzen Monat 48,20 Euro gespart — da freut sich die Haushaltskasse über den smarten Speicher.'
      }
    ],
    `Aktuelle Daten: Ersparnis ${savedEur} €, Zeitraum ${periodLabel}. Erstelle eine kurze Erfolgsmeldung.`
  );
}

export function buildForecastInconsistency({ providerMaxKw, actualKw }) {
  return build(
    BASE_SYSTEM + ' Dein Fokus: Hinweis auf Abweichung zwischen Prognose und Messung.',
    [
      {
        user: 'Aktuelle Daten: Prognose 5.0 kW, Messung 2.1 kW.',
        assistant: 'Es ist wolkiger als erwartet — die Waschmaschine läuft heute etwas später.'
      },
      {
        user: 'Aktuelle Daten: Prognose 3.2 kW, Messung 6.8 kW.',
        assistant: 'Die Sonne ist viel stärker als vorhergesagt — das E-Auto freut sich über den Extra-Bonus.'
      }
    ],
    `Aktuelle Daten: Prognose ${providerMaxKw} kW, Messung ${actualKw} kW. Erstelle eine kurze Notiz zur Abweichung.`
  );
}

export function buildPvRecord({ recordKwh, previousBestKwh }) {
  return build(
    BASE_SYSTEM + ' Dein Fokus: Rekordmeldung der PV-Erzeugung.',
    [
      {
        user: 'Aktuelle Daten: Neuer Tagesrekord 42.5 kWh, vorheriger 38.2 kWh.',
        assistant: 'Heute ein neuer Rekord mit 42,5 Kilowattstunden — die Wärmepumpe freut sich über den Sonnenstrom.'
      },
      {
        user: 'Aktuelle Daten: Neuer Tagesrekord 55.0 kWh, vorheriger 51.0 kWh.',
        assistant: 'Spitzentag mit 55 Kilowattstunden — jede Ladung für das E-Auto war heute quasi gratis.'
      }
    ],
    `Aktuelle Daten: Neuer Tagesrekord ${recordKwh} kWh, vorheriger ${previousBestKwh} kWh. Erstelle eine kurze Rekordnotiz.`
  );
}

export function buildLoadForecastInfo({ expectedPeakKw, peakHour }) {
  return build(
    BASE_SYSTEM + ' Dein Fokus: Vorausschau auf erwarteten Verbrauch.',
    [
      {
        user: 'Aktuelle Daten: Erwartete Spitze 4.8 kW um 18:00.',
        assistant: 'Heute Abend wird es rund 18 Uhr voll — dann laufen Herd und Geschirrspülmaschine gleichzeitig.'
      },
      {
        user: 'Aktuelle Daten: Erwartete Spitze 2.9 kW um 07:00.',
        assistant: 'Morgen früh gegen 7 Uhr kurz mehr Last — wenn alle den Fön benutzen und Kaffee kochen.'
      }
    ],
    `Aktuelle Daten: Erwartete Spitze ${expectedPeakKw} kW um ${peakHour} Uhr. Erstelle eine kurze Vorausschau.`
  );
}

export function buildChargingPlan({ startTime, endTime, targetSocPercent }) {
  return build(
    BASE_SYSTEM + ' Dein Fokus: Ladeplan für das Elektroauto.',
    [
      {
        user: 'Aktuelle Daten: Laden 23:00 bis 05:00, Ziel-SOC 80%.',
        assistant: 'Das Auto lädt heute Nacht von 23 bis 5 Uhr bis auf 80 Prozent — günstig und bereit für morgens.'
      },
      {
        user: 'Aktuelle Daten: Laden 12:00 bis 14:00, Ziel-SOC 90%.',
        assistant: 'Mittagsladung für das E-Auto — zwei Stunden Sonnenstrom bringen es bis auf 90 Prozent.'
      }
    ],
    `Aktuelle Daten: Laden ${startTime} bis ${endTime}, Ziel-SOC ${targetSocPercent}%. Erstelle eine kurze Planmeldung.`
  );
}

export function buildSystemOk({ uptimeHours }) {
  return build(
    BASE_SYSTEM + ' Dein Fokus: Bestätigung, dass alles stabil läuft.',
    [
      {
        user: 'Aktuelle Daten: Laufzeit 36 Stunden, keine Fehler.',
        assistant: 'Alles läuft rund seit anderthalb Tagen — die Trockner-Pläne fürs Wochenende stehen nichts im Weg.'
      },
      {
        user: 'Aktuelle Daten: Laufzeit 720 Stunden, keine Fehler.',
        assistant: 'Schon 30 Tage ohne Zwischenfall — das Smart-Home-System läuft so zuverlässig wie eine alte Küchenuhr.'
      }
    ],
    `Aktuelle Daten: Laufzeit ${uptimeHours} Stunden, keine Fehler. Erstelle eine kurze Bestätigung.`
  );
}
