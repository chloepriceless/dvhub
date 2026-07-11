# Victron: Dynamische PV-Regelung abschalten & zurücksetzen

**Betrifft:** Betreiber mit Victron-GX (Venus OS), die DVhub nur zum Beobachten nutzen oder
eine feste EEG-Einspeisevergütung haben (Volleinspeiser) — und feststellen, dass die PV
abgeregelt bleibt, auch nachdem DVhub deaktiviert oder abgeschaltet wurde.

---

## 1. Warum bleibt die Regelung aktiv, obwohl DVhub aus ist?

DVhubs Steuerbefehle sind **persistente Venus-OS-Einstellungen**. Ein einmal geschriebener
Wert bleibt im Victron-System gespeichert und **wirkt weiter, auch wenn DVhub gestoppt oder
die VM abgeschaltet wird** — DVhub muss den Wert aktiv zurücksetzen, sonst bleibt er stehen.

Für die dynamische PV-Einspeise-Regelung schreibt DVhub diese beiden Einstellungen:

| Venus-Setting (MQTT / D-Bus) | Modbus-Register | Bedeutung | „Frei"-Wert |
|---|---|---|---|
| `Settings/CGwacs/OvervoltageFeedIn` | `2707` | DC-PV-Überschuss einspeisen | `1` (erlaubt) |
| `Settings/CGwacs/PreventFeedback` | `2708` | AC-PV-Einspeisung unterbinden | `0` (nicht unterbinden) |

Wenn DVhub „abregelt", setzt es `OvervoltageFeedIn = 0` **und** `PreventFeedback = 1`. Genau
das bleibt nach dem Abschalten stehen und regelt die PV weiter ab.

*(Nutzt du zusätzlich die Batterie-/Arbitrage-Steuerung, schreibt DVhub außerdem
`Settings/CGwacs/AcPowerSetPoint` (reg 2700), `MaxDischargePower` (reg 2704) und
`BatteryLife/MinimumSocLimit` (reg 2702). Für die reine PV-Abregelung sind aber die beiden
oben entscheidend.)*

---

## 2. Dauerhaft abschalten — der richtige Weg (ab Update vom 2026-07-11)

In DVhub unter **Einstellungen → Einspeisung & Tarif → „Aktive Anlagensteuerung (DV-Schnittstelle)"
deaktivieren**.

Neu ab diesem Update: Beim Deaktivieren (und bei jedem Start mit deaktivierter Steuerung)
**gibt DVhub die Einspeisung einmalig aktiv frei** — es setzt `OvervoltageFeedIn = 1` und
`PreventFeedback = 0` zurück und lässt die Anlage danach in Ruhe. Damit verschwindet die
zuvor gesetzte Sperre automatisch, statt stehen zu bleiben.

Voraussetzung: DVhub auf den aktuellen **Bleeding-Edge (Dev)**-Stand aktualisieren
(Einstellungen → Software → „Auf Updates prüfen" → installieren).

> Der **Not-Halt** gibt die PV ebenfalls sofort wieder frei (schreibt dieselben „Frei"-Werte).

---

## 3. Manuell zurücksetzen (wenn DVhub aus bleiben soll)

Willst du DVhub gar nicht mehr laufen lassen, kann es die Sperre nicht mehr selbst aufheben —
dann setzt du die beiden Venus-Settings einmal manuell auf den „Frei"-Wert:

**Venus OS Node-RED** (D-Bus-Node auf `com.victronenergy.settings`):
- `/Settings/CGwacs/OvervoltageFeedIn` → `1`
- `/Settings/CGwacs/PreventFeedback` → `0`

**Alternativ per Kommandozeile** auf dem GX (SSH, Root-Zugriff aktiviert):
```bash
dbus -y com.victronenergy.settings /Settings/CGwacs/OvervoltageFeedIn SetValue %1
dbus -y com.victronenergy.settings /Settings/CGwacs/PreventFeedback   SetValue %0
```

Danach speist die Anlage wieder normal ein. (Das ist genau der Zustand, den DVhub mit dem Fix
aus Abschnitt 2 automatisch herstellt — die manuelle Variante ist nur für „DVhub bleibt aus".)

---

## 4. Wann sollte die Steuerung AN bleiben?

Nur wenn du an der **Direktvermarktung mit dynamischen Börsenpreisen** teilnimmst
(Einspeise-Modus „Spot"). Dann regelt DVhub die Einspeisung bewusst bei negativen/sehr
niedrigen Preisen ab, um Verluste zu vermeiden. Bei **fester EEG-Vergütung** oder reinem
Beobachten: Steuerung deaktivieren (Abschnitt 2).
