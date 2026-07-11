# Herstellerprofil migrieren (`.dist`-Datei nach einem Update)

**Kurz:** Wenn du ein Herstellerprofil selbst angepasst hast (z. B. `victron.json` mit
deiner Broker-IP oder eigenen Registern) und ein DVhub-Update eine neuere Version dieses
Profils mitbringt, **überschreibt DVhub deine Datei nicht**. Stattdessen legt es die neue
Version als `<name>.dist` daneben — damit deine Anpassungen sicher sind. Diese Anleitung
zeigt, wie du die neuen Verbesserungen übernimmst, ohne deine Anpassungen zu verlieren.

---

## 1. Warum gibt es eine `.dist`-Datei?

DVhub gleicht beim Update die ausgelieferten Herstellerprofile mit deinen aktiven Profilen
in `/etc/dvhub/hersteller/` ab:

- **Unverändertes Profil** → wird automatisch auf die neue Version aktualisiert (du bekommst
  Bugfixes ohne Zutun).
- **Von dir geändertes Profil** → bleibt unangetastet; die neue Version landet als
  `/etc/dvhub/hersteller/<name>.json.dist`. Du entscheidest, was du übernimmst.

So bekommst du Verbesserungen (z. B. neue Telemetrie- oder Alarm-Register), ohne dass ein
Update deine sorgfältig eingestellten Werte überschreibt.

## 2. Unterschiede ansehen

```bash
cd /opt/dvhub
node scripts/vendor-profile-diff.mjs victron.json
```

Die Ausgabe teilt die Unterschiede in drei Gruppen:

- **NEU in der neuen Version (sicher übernehmbar)** — Felder, die es in deiner Version noch
  nicht gibt (z. B. eine neue `alarms`-Sektion). Diese kannst du gefahrlos übernehmen.
- **DEINE Anpassung, in neuer Version anders** — Felder, die du geändert hast (z. B. die
  Broker-IP). Bleiben, wie sie sind — du entscheidest bewusst, ob du den neuen Wert willst.
- **NUR bei dir** — Felder, die du ergänzt hast (z. B. ein zusätzliches Register) und die die
  neue Version nicht kennt. Bleiben erhalten.

## 3. Neue Felder übernehmen (der sichere Weg)

```bash
node scripts/vendor-profile-diff.mjs victron.json --apply-additions
sudo systemctl restart dvhub
```

`--apply-additions` übernimmt **ausschließlich die neu hinzugekommenen Felder** ins aktive
Profil und legt vorher automatisch ein Backup an (`<name>.bak-<zeitstempel>`). Es **ändert
oder entfernt niemals** ein bestehendes Feld — deine Broker-IP, Register und sonstigen
Anpassungen bleiben exakt erhalten. Nach dem Neustart ist das aktualisierte Profil aktiv.

## 4. Geänderte oder entfernte Felder (manuell)

Werte, die du bewusst angepasst hast, und Felder, die in der neuen Version wegfallen, nimmt
das Werkzeug **nicht** automatisch — das könnte eine laufende Steuerung stören. Wenn du einen
geänderten Standardwert doch übernehmen willst, editiere `/etc/dvhub/hersteller/<name>.json`
von Hand (die `.dist`-Datei zeigt den neuen Wert), sichere vorher eine Kopie und starte
danach neu.

## 5. Aufräumen

Ist die Migration erledigt, kannst du die `.dist`-Datei löschen:

```bash
rm /etc/dvhub/hersteller/victron.json.dist
```

Beim nächsten Update, das das Profil erneut ändert, wird sie bei Bedarf neu erzeugt.

---

*Kein Zugriff auf die Kommandozeile? Dann ignoriere die `.dist`-Datei einfach — dein aktives
Profil funktioniert unverändert weiter; du verpasst nur die neuen optionalen Felder.*
