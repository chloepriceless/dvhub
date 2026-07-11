# Fronius: DVhub-Abregelung erkennen und zurücksetzen

**Betrifft:** Fronius-GEN24-Beta-Profil vor dem Fix vom 2026-07-11. Symptom: Nach dem
Verbinden mit DVhub drosselt die PV, der Wechselrichter lädt nur noch den Speicher, das Haus
zieht Netzstrom.

---

## 1. Was war los?

Das erste Fronius-Beta-Profil hat die Direktvermarktungs-Abregelung über **SunSpec Model 123**
umgesetzt und dabei die Victron-Logik zu direkt übernommen. Konkret hat DVhub zwei Register
gesetzt:

| Register (SunSpec Model 123) | Wert | Bedeutung |
|---|---|---|
| `WMaxLimPct` | `0` | Wirkleistungsgrenze des Wechselrichters = **0 %** |
| `WMaxLim_Ena` | `1` | Grenze **aktiv** |

`WMaxLimPct` begrenzt die **gesamte Wirkleistung des Wechselrichters**, nicht nur die
Netzeinspeisung. Bei einer Hybrid-Anlage (GEN24 + Batterie) heißt 0 %: Der Wechselrichter darf
nichts mehr ans Haus/Netz liefern, die überschüssige PV wandert in die Batterie, und das Haus
wird aus dem Netz versorgt. Das ist **nicht** dasselbe wie Victrons „Nulleinspeisung", bei der
das Haus weiter aus PV und Batterie versorgt wird — die beiden Mechanismen sind nicht
äquivalent, und `WMaxLimPct` ist für eine reine Einspeise-Abregelung das falsche Register.

**Der Fix (ab 2026-07-11):** Das Fronius-Profil schreibt in Stufe 1 **kein** `WMaxLim`-Register
mehr (die DV-Abregelung ist deaktiviert). Telemetrie/Leitstand/Historie laufen normal weiter.
Die korrekte Abregelung (Export-Limitierung über den Smart Meter, die nur den Netzpunkt regelt)
kommt mit dem Soft-ESS-Regler.

---

## 2. Sofort zurücksetzen — der schnellste Weg

> **Wichtig:** Diesen Schritt **zuerst** machen, *bevor* du auf die gefixte Version aktualisierst.
> Mit der noch aktiven (alten) Version kann DVhub die Sperre selbst aufheben. Nach dem Update
> schreibt DVhub keine `WMaxLim`-Register mehr — dann muss eine noch stehende Sperre am Fronius
> zurückgesetzt werden (Abschnitt 3).

**In DVhub den Not-Halt / Notaus drücken.** Der Not-Halt gibt die PV bewusst frei und schreibt
`WMaxLim_Ena = 0` auf den Wechselrichter zurück — die Anlage läuft danach wieder normal
(volle Leistung, Haus wird versorgt). Anschließend den Not-Halt wieder aufheben.

Prüfen: Im Leitstand sollte die PV-Leistung wieder auf den erwarteten Wert steigen und der
Netzbezug fürs Haus verschwinden.

---

## 3. Manuell am Fronius zurücksetzen (Fallback / nach dem Update)

Falls der Not-Halt nicht greift oder du bereits auf die gefixte Version aktualisiert hast
(dann schreibt DVhub das Register nicht mehr von selbst zurück):

**Variante A — Fronius-Weboberfläche (empfohlen):**
Am Wechselrichter anmelden (Techniker-/Anlagenbetreiber-Login) → *Sicherheits- und
Netzanforderungen* bzw. *Dynamische Leistungsreduzierung* → die Wirkleistungsbegrenzung
wieder auf **100 %** stellen bzw. deaktivieren. Danach kurz prüfen, dass die Anlage wieder
voll produziert.

**Variante B — direkt per Modbus** (wenn du ohnehin ein Modbus-Tool nutzt):
- `WMaxLim_Ena` (SunSpec Model 123, Offset +7) auf **0** setzen, **oder**
- `WMaxLimPct` (Model 123, Offset +3) auf **10000** (= 100,00 %, Skalenfaktor −2).

Die absoluten Registeradressen hängen vom SunSpec-Scan deiner Anlage ab (Float- vs.
Integer-Layout verschiebt die Modell-Basis) — im Log deiner DVhub-Instanz stehen sie unter
`sunspec_scan_ok`.

---

## 4. Wichtig: das aktive Profil wird beim Update NICHT automatisch ersetzt

DVhub legt Herstellerprofile beim Installieren **create-if-missing** unter
`/etc/dvhub/hersteller/<hersteller>.json` ab und **überschreibt ein bereits vorhandenes Profil
nie** (damit eigene Anpassungen erhalten bleiben). Das hat zwei Seiten:

- ✅ **Deine eigenen Änderungen** an einer Vendor-JSON bleiben bei einem Update erhalten.
- ⚠️ **Ein Profil-Fix aus einem Update erreicht dich nicht automatisch** — die gefixte Datei
  landet nur im Programmordner (`/opt/dvhub/dvhub/hersteller/`), nicht in deinem aktiven
  `/etc/dvhub/hersteller/`.

**Deshalb nach dem Update das gefixte Fronius-Profil einmalig aktiv übernehmen:**

```bash
# gefixte Version über das aktive Profil legen und DVhub neu starten
sudo cp /opt/dvhub/dvhub/hersteller/fronius.json /etc/dvhub/hersteller/fronius.json
sudo chown dvhub:dvhub /etc/dvhub/hersteller/fronius.json
sudo systemctl restart dvhub
```

> Falls du dein `fronius.json` **selbst angepasst** hast, vorher sichern
> (`cp … fronius.json fronius.json.bak`) und die Änderungen danach wieder einpflegen — der
> `cp` oben ersetzt die Datei vollständig.

*Ab DVhub 1.0.2 ist der manuelle `cp` in der Regel nicht mehr nötig: Das Update aktualisiert
ein **unverändertes** Profil automatisch auf die neue Version; ein von dir **geändertes**
Profil bleibt stehen und die neue Version liegt als `fronius.json.dist` bereit — siehe
[`docs/HERSTELLERPROFIL-MIGRIEREN.md`](HERSTELLERPROFIL-MIGRIEREN.md).*
