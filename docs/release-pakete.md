# Signierte Release-Pakete für native Installationen

Stand: 27.10.2026 · Branch `feat/release-pakete`

Native Boxen (Debian, Raspberry Pi OS, Armbian; arm64, selten armhf und amd64) aktualisieren sich bisher als
git-Checkout: `dvhub-update` holt einen Tag oder `main`, danach `npm install` und `post-update.sh`. Jede Box trägt
so ~73 MB git-Historie und ~1000 Dateien, von denen ~400 zum Laufen gebraucht werden, und `npm install` ist auf
schwachen Boards der langsamste und anfälligste Schritt. Dieses Dokument beschreibt den Ersatz: fertige, signierte
Pakete je Version und Architektur, die die Box nur noch prüft, auspackt und umschaltet.

Docker-Images bleiben, wie sie sind.

## Überblick

```
Mac (lokal)                          GitHub Releases (öffentlich)           Box (root)
build-release.sh v1.0.9  ─►  dvhub-1.0.9-arm64.tar.gz(.sig)   ─►  dvhub-release check|install|rollback
  git archive → Allowlist            dvhub-1.0.9-armhf.tar.gz(.sig)        Download → sha256 → Signatur
  npm ci --omit=dev                  dvhub-1.0.9-amd64.tar.gz(.sig)        → /opt/dvhub/releases/1.0.9
  EEBUS-Binary je Arch (Go quer)     channels/index-stable.json(.sig)       → current umschalten → Neustart
  tar (Node, deterministisch)        channels/index-dev.json(.sig)          → /health → sonst Rückweg
  ssh-keygen -Y sign
publish-release.sh (gh)
```

## 1. Bau auf dem Mac (`scripts/release/`)

`build-release.sh <tag|ref> [--arch arm64,armhf,amd64] [--out DIR] [--key PFAD]`

1. **Export:** `git archive <sha>` in ein leeres Zeitverzeichnis. Der Arbeitsbaum spielt keine Rolle; liegengebliebene
   Dateien, `node_modules` oder lokale Configs können nicht ins Paket rutschen.
2. **Allowlist** (`scripts/release/allowlist.txt`, geprüft von `lib/release-lib.mjs`): nur was eine Box ausführt —
   `dvhub/` ohne `test/`, `docs/`, Lint-Konfiguration und Entwickler-Skripte; die Root-Skripte, die `install.sh`,
   `post-update.sh` und die Hilfsskripte aufrufen (`*-provision.sh`, `dvhub-*.sh`, `pkg-maintain.sh`,
   `stack-update.sh`, `pg-write-tuning.sh`, `20-dv-modbus.sh`); `eos-version.env`, `eos-patches/`,
   `scripts/reconcile-vendor-profiles.mjs`, `scripts/migrate-sqlite-to-pg.sh` mit `db/postgres/migrations`;
   Herstellerprofile und SQL-Migrationen liegen in `dvhub/`; Lizenztexte; `release-keys/allowed_signers`. Nicht
   enthalten: `.git`, `test/`, `tests/`, `docs/`, `assets/`, `installer-portal/`, `support-relay/`, `docker/`,
   `.github/`, Planungsdateien. Die Liste ist „alles verbieten, gezielt erlauben“ (wie `.dockerignore`); eine neue
   Datei im Repo landet erst im Paket, wenn sie dort eingetragen ist. Der Bau bricht ab, wenn eine Datei, die ein
   Skript im Paket aufruft, fehlt (Querprüfung der `$INSTALL_DIR/…`-Aufrufe in `post-update.sh`).
3. **Abhängigkeiten:** `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` im Paketbaum. Vor dem Packen prüft
   der Bau **je Release**, dass keine Produktionsabhängigkeit Lifecycle-Skripte (`preinstall`, `install`,
   `postinstall`), `binding.gyp`, `.node`-Binaries oder `os`/`cpu`-Einschränkungen im Lockfile hat. Schlägt das an,
   bricht der Bau ab — dann wäre `node_modules` nicht mehr architekturneutral (heute: 0 Treffer).
4. **Architekturabhängiges — EEBUS-Binary vorgebaut:** `dvhub-eebus` (Go, enbility eebus-go) wird auf dem Mac quer
   übersetzt (`golang:<GO_VERSION>-alpine`, `CGO_ENABLED=0`, `GOARCH` arm64/amd64/arm mit `GOARM=7`, `-trimpath`,
   `-buildid=`) und liegt im Paket unter `dvhub/eebus/dist/`. Begründung: Das Binary ist statisch und ohne CGO, der
   Querbau braucht keine Emulation und ist reproduzierbar; auf der Box entfallen Go-Download (~70 MB), Übersetzung
   (auf einem Cortex-A53 mehrere Minuten, mit `-p=1` bei < 1,5 GB RAM) und eine weitere Netzabhängigkeit.
   `eebus-provision.sh` nimmt das vorgebaute Binary, wenn es zur Architektur passt (Selbsttest wie bisher), und baut
   nur noch für die C-Fassung (`.eebus-impl-c`) oder ohne passendes Binary selbst.
   EOS und die Python-Prognose bleiben auf der Box (pip-Räder je Plattform und Python-Version, versioniert über
   `eos-version.env` und `requirements.lock`; die venvs liegen außerhalb der Releases und überleben jedes Update).
5. **Format `tar.gz`:** `gzip` ist auf jedem Debian `Priority: required`, `zstd` nicht (auf minimalen Images und
   Raspberry Pi OS Lite nicht garantiert). Der Größenunterschied (~15–20 %) ist bei wenigen MB unerheblich, das
   Entpacken auf schwachen Boards billig.
6. **Reproduzierbar:** Das tar schreibt der Bau selbst (Node, `lib/release-lib.mjs`): Einträge nach Pfad sortiert,
   `mtime` = Commit-Zeit, Besitzer 0/0 `root`, Modi normalisiert (Verzeichnisse 0755, Dateien 0644 bzw. 0755 bei
   gesetztem x-Bit, Symlinks 0777), PAX-Kopf nur für lange Pfade. gzip mit Stufe 9, `mtime` 0 und OS-Byte 3 (Unix).
   Gleiche Ref → gleiche Bytes (Test: zweimal bauen, Hash vergleichen). Grenze: Gleichheit der `.tar.gz`-Bytes gilt
   für denselben zlib-Stand; der Bau protokolliert Node-, npm-, zlib- und Go-Version im Manifest.
7. **Manifest** `.dvhub-release.json` im Paketwurzelordner (damit mitsigniert) und als
   `dvhub-<v>-<arch>.manifest.json` daneben: Format, Version, Kanal, Tag, Git-SHA, Commit-Zeit, Architektur,
   `node_engine` (aus `package.json`), `.node-version`, EOS-Pin, Lockfile-Hash, Werkzeugversionen und die Dateiliste
   mit sha256, Größe und Modus.
8. **Version:** Tag `vX.Y.Z` → `X.Y.Z` (Kanal stable; der Tag muss zur `package.json`-Version passen). Jede andere
   Ref → `<package.json-Version>-dev.<Commit-Zeit UTC JJJJMMTThhmmss>.<sha8>` (Kanal dev). Innerhalb des Kanals
   ordnet die Commit-Zeit. Achtung Semver: `1.0.8-dev.…` sortiert vor `1.0.8`; Kanalwechsel installieren darum
   bewusst „das Neueste des Zielkanals“ (wie heute), ohne Downgrade-Sperre, nach Rückfrage.

## 2. Signatur: `ssh-keygen -Y`

- **Warum ssh-keygen:** liegt auf jeder Box (openssh-client installieren `install.sh` und `post-update.sh` ohnehin
  für den Fern-Support), kann Ed25519, Namensräume (`-n`) und eine `allowed_signers`-Datei mit mehreren Schlüsseln
  und Gültigkeitsfenstern (`valid-after`/`valid-before`) — genau das, was eine Schlüsselrotation braucht.
  Verworfen: **GnuPG** (auf minimalen Debian-Images nicht installiert, Schlüsselbund-Verwaltung als root schwerfällig),
  **minisign/signify** (kein Debian-Standardpaket), **openssl pkeyutl** (könnte Ed25519, aber ohne Namensräume und
  ohne Mehrschlüssel-Vertrauensdatei — Rotation müssten wir selbst bauen).
- **Schlüssel:** eigener Ed25519-Schlüssel nur für Releases, auf dem Mac unter `~/.config/dvhub-release/` (Ordner
  0700, Datei 0600). Die Skripte nehmen ihn über `--key`; Tests erzeugen Wegwerfschlüssel.
- **Signiert werden** jedes Paket (Namensraum `dvhub-release`) und jeder Kanal-Index (Namensraum
  `dvhub-release-index`; eine Paketsignatur lässt sich so nicht als Index-Signatur ausgeben). Prinzipal:
  `dvhub-release`.
- **Vertrauensanker auf der Box:** `/etc/dvhub-release/allowed_signers` (root:root 0644, bewusst nicht in
  `/etc/dvhub`, das dem Dienstbenutzer gehört). Erstausstattung: `post-update.sh` legt die Datei aus
  `release-keys/allowed_signers` des Checkouts an, wenn sie fehlt — die Vertrauenskette beginnt damit beim heutigen
  git-Update über HTTPS.
- **Rotation:** Ein Paket, das noch mit dem alten Schlüssel signiert ist, liefert eine `allowed_signers` mit altem und
  neuem Schlüssel aus. Die Box übernimmt die Datei nur aus einem Paket, das gegen die *bisherige* Datei geprüft
  wurde, und nur, wenn seine Version neuer ist als die, aus der die Datei zuletzt kam (ein Rückweg auf ein altes Paket
  ändert das Vertrauen nicht). Spätere Pakete mit dem neuen Schlüssel gelten; ein Paket mit neuem Schlüssel liefert
  später die Datei ohne den alten aus.
- **Solange `release-keys/allowed_signers` keinen Schlüssel enthält** (heute), lehnt die Box jedes Paket ab und die
  Umstellung startet nicht — der Code kann also vor dem ersten Schlüssel ausgeliefert werden.

## 3. Kanäle und Verteilung

- **stable** = Pakete aus `vX.Y.Z`-Tags, als Assets am GitHub-Release des Tags.
- **dev** = Pakete aus `main`, als Assets an einem rollierenden Vorab-Release `dev` (die letzten 3 Stände bleiben
  liegen, ältere räumt `publish-release.sh` weg).
- **Index je Kanal** am Vorab-Release `channels` (fester Pfad, nie „latest“):
  `…/releases/download/channels/index-stable.json` und `index-dev.json`, jeweils mit `.sig`. Inhalt: Format, Kanal,
  `latest`, und je Version Tag, Git-SHA, Datum, `node_engine`, Änderungen (CHANGELOG-Abschnitt bzw. Commit-Betreffs) und
  je Architektur `url` (relativ zum Index, z. B. `../v1.0.9/dvhub-1.0.9-arm64.tar.gz`), `sha256`, `size`, `sig`.
  Relative URLs machen Spiegel und den lokalen Test-Server ohne Umschreiben möglich.
- **Quelle auf der Box:** fest im Helfer (`https://github.com/chloepriceless/dvhub/releases/download`), überschreibbar
  nur root-seitig über `/etc/dvhub-release/release.conf` (`base_url=`), nicht aus der Oberfläche.
- `publish-release.sh <build-dir> [--dry-run --dest DIR] [--key …]` legt im Dry-Run genau die GitHub-Struktur
  (`<tag>/<asset>`, `channels/index-*.json`) lokal ab und zeigt die `gh`-Befehle, die es sonst ausführen würde.

## 4. Box-Seite

### Layout

```
/opt/dvhub/                         root:root 0755  (INSTALL_DIR, bleibt der Bezugspunkt aller Skripte)
├── releases/1.0.9/                 root-eigen, für dvhub nur lesbar (Paketinhalt + .dvhub-release.json)
├── releases/1.0.10/
├── current -> releases/1.0.10      relativer Symlink, atomar per rename(2) umgeschaltet
├── dvhub -> current/dvhub          Kompatibilitäts-Links für jeden Eintrag der obersten Paketebene:
├── post-update.sh -> current/…     andere Units (pkg-maintain, Fern-Support), Hinweise in Doku und Oberfläche
├── eos-provision.sh -> current/…   und alle "$INSTALL_DIR/<skript>"-Aufrufe laufen unverändert über current
├── eos/ eos-venv/ forecast-venv/ bin/   Zustand der Box (venvs, EEBUS-Binary) — außerhalb der Releases
└── .legacy-git/                    der alte git-Checkout nach der Umstellung (Rückweg, später entfernt)
/var/lib/dvhub-release/             root 0755: state.json, status.json, staging/ (0700), Protokolle
/etc/dvhub-release/                 allowed_signers, optional release.conf
/usr/local/libexec/dvhub-release    der Helfer (root, 0755)
```

Die systemd-Unit zeigt ausdrücklich durch `current`:
`WorkingDirectory=/opt/dvhub/current/dvhub`, `ExecStartPre=-+/usr/bin/bash /opt/dvhub/current/post-update.sh`,
`ExecStart=/usr/bin/node /opt/dvhub/current/dvhub/server.js`. Feste Pfade im Code (`/opt/dvhub/forecast-venv`,
`/opt/dvhub/bin/dvhub-eebus`, Hinweise auf `/opt/dvhub/*.sh`) bleiben gültig: venvs und `bin/` sind Box-Zustand,
Skripte erreichen die Kompatibilitäts-Links. `post-update.sh` erkennt das Paket-Layout an `.dvhub-release.json` neben
sich, setzt `INSTALL_DIR` auf den Box-Ordner und `APP_DIR` auf `current/dvhub`, überspringt `npm install`
(`node_modules` ist im Paket) und hält die Unit auf den `current`-Pfaden.

### Helfer `dvhub-release` (Node, nur Bordmittel: `node:*`, `tar`, `ssh-keygen`, `systemctl`, `systemd-run`)

Wie die übrigen `/usr/local/libexec/dvhub-*`: root-eigene Kopie, Platzhalter beim Installieren fest eingetragen,
sudoers nur mit festen Aktionen:

| Aktion | sudo für dvhub | Wirkung |
|---|---|---|
| `check <stable\|dev>` | ja | Index laden, Signatur prüfen, Versionen vergleichen, JSON ausgeben |
| `install <version\|latest> <stable\|dev>` | ja | prüft Argumente, startet den Auftrag als eigene Unit (`systemd-run`), kehrt sofort zurück |
| `rollback` | ja | auf die vorige Version umschalten (ohne Download), als eigene Unit |
| `status` | ja | Fortschritt/Ergebnis des letzten Auftrags (JSON) |
| `migrate [--force]` | nein (root, Zeitgeber) | einmalige Umstellung git → Paket |
| `boot-hook` | nein (aus `post-update.sh`) | Umstellung planen bzw. unterbrochenen Auftrag fortsetzen lassen |
| `recover` | nein (Notfall-Drop-in der Unit) | im Verschieben abgebrochene Umstellung sofort zurücknehmen |

Intern (nicht von Hand): `_job install|rollback|migrate|resume` — der eigentliche Auftrag als eigene Unit; `resume`
prüft nach einem Stromausfall mitten im Update die Gesundheit und bestätigt oder geht zurück.

Ablauf `install`:
1. Sperre (`/run/dvhub-release.lock`), Platz prüfen (Staging und `/opt/dvhub` brauchen je ~3× Paketgröße).
2. Index laden und prüfen (Signatur, Kanal, Architektur), Paket nach `staging/` laden (root 0700; bis zu drei
   Versuche, setzt mit `Range` fort; Größe aus dem Index ist Obergrenze), sha256 und Signatur prüfen.
3. Nach `releases/<v>.partial` entpacken (`tar --no-same-owner --no-same-permissions` als root), jede Datei gegen
   das Manifest prüfen (keine fehlende, keine zusätzliche, Hash stimmt), Version/Architektur im Manifest = Anfrage,
   `node_engine` passt zur installierten Node-Version; dann zu `releases/<v>` umbenennen.
4. `pending` in `state.json` vermerken, `current` atomar umschalten, Kompatibilitäts-Links abgleichen.
5. `post-update.sh` des neuen Releases (Provisionierung, Hilfsskripte, sudoers, Unit; 5 min).
6. `systemctl restart`, Gesundheitsprüfung: `/health` auf `httpPort` (aus der Config) antwortet `ok` mit der neuen
   Version (bis 180 s).
   Startet die neue Version gar nicht (Absturzschleife, ≥ 3 Neustarts laut systemd), bricht die Prüfung sofort ab.
7. Gut → bestätigen, Vertrauensdatei ggf. übernehmen, alte Releases aufräumen (Vorgabe: aktuelles und voriges,
   `keep_releases=2…5` in `release.conf`; entpackt ~93 MB je Release). Schlecht → `current` zurück, Neustart
   (ExecStartPre bringt Hilfsskripte/sudoers des alten Stands zurück), Gesundheit prüfen, Ergebnis `rolled_back`.

`/etc/dvhub` und `/var/lib/dvhub` fasst der Helfer nicht an.

### Oberfläche

`routes/admin-routes.js` erkennt das Paket-Layout (`.dvhub-release.json` über dem App-Ordner) und ruft dann den
Helfer statt git: `check` liefert dieselbe Antwortform wie bisher (`current`, `latest`, `updateAvailable`,
`changelog`); `apply` startet den Auftrag und antwortet sofort; neu `GET /api/admin/update/status` (Fortschritt:
Download, Prüfung, Entpacken, Einrichten, Neustart, Gesundheitsprüfung, Ergebnis) und `POST
/api/admin/update/rollback`. Die Seite fragt den Status alle 2 s ab, überbrückt den Neustart und zeigt das
Ergebnis. Kanalwechsel = Config speichern + `install latest <kanal>`.

## 5. Umstellung git → Paket

Einmalig beim nächsten Update einer git-Box:
1. Die Box aktualisiert sich noch einmal auf dem alten Weg (alte Oberfläche: git + `post-update.sh`) auf die erste
   Version mit Paketunterstützung. Deren `post-update.sh` installiert Helfer, sudoers und Vertrauensanker und plant
   die Umstellung als Zeitgeber-Unit (`systemd-run --on-active=120s`), damit sie nicht mit dem Neustart der
   Oberfläche kollidiert.
2. `dvhub-release migrate`: Paket des eigenen Kanals laden und prüfen (kein Downgrade gegenüber dem Checkout),
   nach `releases/<v>` entpacken, `current` setzen, die versionierten Einträge der obersten Ebene und `.git` nach
   `.legacy-git/` verschieben und an ihrer Stelle Kompatibilitäts-Links anlegen (je Eintrag rename + symlink;
   Journal in `state.json`), Unit sichern und auf `current` umschreiben, `post-update.sh`, Neustart,
   Gesundheitsprüfung.
3. Gesund → fertig; der alte Checkout bleibt in `.legacy-git/` und wird beim nächsten erfolgreichen Paket-Update
   entfernt (abschaltbar mit `/etc/dvhub-release/keep-legacy-git`). Nicht gesund → Links und `current` weg,
   Einträge zurück, Unit zurück, Neustart auf dem git-Stand; erneuter Versuch frühestens nach 24 h, höchstens 5-mal.
4. Ein halb umgestellter Stand bleibt startfähig: die Kompatibilitäts-Links zeigen auf das neue Release, die alte
   Unit (`/opt/dvhub/dvhub/server.js`) startet also schon über `current`.

Nicht automatisch umgestellt (bleiben auf git-Updates, Protokolleintrag und Hinweis in der Oberfläche):
- **eigene `--repo`-Quelle:** `origin` zeigt nicht auf `github.com/chloepriceless/dvhub`. Die Pakete sind aus dem
  offiziellen Repo gebaut und mit dem DVhub-Schlüssel signiert; ein Fork würde stillschweigend durch den offiziellen
  Code ersetzt. Vorschlag: Option `/etc/dvhub-release/release.conf` `migrate_custom_repo=1` bzw.
  `dvhub-release migrate --force` von Hand. Wer eigene Pakete will, baut sie mit eigenem Schlüssel, trägt ihn in
  `allowed_signers` ein und setzt `base_url`.
- **geänderte versionierte Dateien** im Checkout (lokale Patches): nur mit `--force`; sie lägen danach nur noch in
  `.legacy-git/`.
- **`.no-release-packages`** in `/var/lib/dvhub` (Opt-out) und Boxen ohne Schlüssel in `allowed_signers`.

v0.4.x-Boxen: Ihre Oberfläche holt den neuen Stand per git, ruft aber kein `post-update.sh` als root auf (Unit
ohne `ExecStartPre`, keine sudo-Regel), und der neue Stand startet ohne `apiToken` nicht (den erzeugt nur
`install.sh`). Sie brauchen wie beim Sprung auf 1.0 einmal den Installer erneut
(`curl -fsSL https://raw.githubusercontent.com/chloepriceless/dvhub/main/install.sh | sudo bash`; `post-update.sh`
allein reicht nicht); danach läuft die Umstellung wie oben.

## 6. Tests

- Node-Tests (`test/release-*.test.js`): Allowlist, Reproduzierbarkeit (zweimal bauen), Manifest, tar-Leser/-Schreiber,
  Signieren/Prüfen (gut, verändert, falscher Schlüssel, rotierter Schlüssel), Index- und Versionslogik,
  Argumentprüfung des Helfers, Layout-Erkennung, Umschalten/Rückweg im Wegwerf-Wurzelordner.
- Docker-Matrix (`scripts/release/boxsim/`): Debian bookworm mit systemd als PID 1; jede Version v1.0.0…v1.0.8 und
  v0.4.2 mit ihrem eigenen `install.sh` installiert, dann Update über die alte Oberfläche, Umstellung auf das Paket,
  weiteres Paket-Update und Rückweg; Negativfälle. Ergebnisse und Protokolle unter `~/Projects/release-tests/`.

## Ergebnisse (27.10.2026, Prüfstand Debian bookworm arm64, systemd)

Pakete aus diesem Branch (Test-Releases 1.0.9/1.0.10/1.0.11, Wegwerf-Schlüssel), Protokolle unter
`~/Projects/release-tests/runs/`. Jede Version mit ihrem eigenen `install.sh` installiert, über die *alte*
Oberfläche per git auf die Brücke 1.0.9, automatische Umstellung, Paket-Update auf 1.0.10 über die neue Oberfläche,
Rückweg auf 1.0.9; Marker in Config, Daten, Datenbank und Box-Zustand, Kanal und Config-Schlüssel geprüft.

- v1.0.0 … v1.0.8 (stable), v1.0.0 und v1.0.8 (dev), v0.4.2: alle umgestellt, aktualisiert, zurückgerollt, Daten und
  Kanal erhalten. Umstellung ~9 s, Paket-Update ~9 s, Rückweg ~8 s (ohne Downloadzeit über das Netz; lokal 24 MB).
- v0.4.2: braucht wie beim Sprung 0.4 → 1.0 einmal den Installer (die alte Oberfläche ruft kein `post-update.sh`
  als root auf, und der neue Stand startet ohne `apiToken` nicht) — danach normal.
- Negativfälle (v1.0.8): verändertes Paket, fremde Signatur, Download bricht immer ab, Platte voll → abgelehnt,
  Box unverändert; Download bricht einmal ab → setzt fort; neue Version startet nicht → nach ~20 s zurück.
- armv7 (Debian bookworm armhf unter QEMU, v1.0.8 → 1.0.9 per Installer → Paket → 1.0.10 → zurück): ok; unter
  Emulation Umstellung 38 s, Update 30 s, Rückweg 25 s. NodeSource baut für armhf nicht mehr — `install.sh` kann dort
  Node 22 nicht selbst holen (Prüfstand nimmt das Archiv von nodejs.org).
- Stromausfall mitten im Verschieben (echter Container-Neustart): `recover` läuft vor `post-update.sh`, git-Stand
  gesund, danach normale Umstellung.
- Altfehler gesehen (nicht durch die Pakete): Die Oberfläche bis v1.0.8 räumt beim git-Update `forecast-venv/` per
  `git stash --include-untracked` weg (`.gitignore` kannte es nicht); behoben seit 25.10. auf main.
- Größe: git-Installation 164 MB / ~7000 Dateien (davon `.git` 56 MB, `node_modules` 64 MB) → je Release 93 MB
  entpackt / 6860 Dateien (≈420 eigene, Rest `node_modules`, dazu 14 MB EEBUS-Binary), Download 24–25 MB.

## Einmalig für die Eigentümerin

1. **Schlüssel anlegen** (nur auf dem Mac, nie in ein Repo):
   ```bash
   install -d -m 0700 ~/.config/dvhub-release
   ssh-keygen -t ed25519 -C dvhub-release-2026 -f ~/.config/dvhub-release/release_ed25519   # mit Passphrase
   chmod 600 ~/.config/dvhub-release/release_ed25519
   ```
   Mit Passphrase fragt `ssh-keygen -Y sign` beim Bau danach (oder einmal `ssh-add` in den Agenten).
2. **Sichern:** privaten Schlüssel samt Passphrase in 1Password (Dokument), zusätzlich offline (verschlüsselter
   USB-Stick). Geht er verloren, gibt es keinen Weg zu neuen Paketen außer einem git-Update mit neuer
   `allowed_signers` — Boxen auf Paketen bekommen dann nichts mehr. Wird er kompromittiert: neuen Schlüssel per
   Rotation einführen (mit dem alten signiertes Paket, dann alten entfernen) und `valid-before` setzen.
3. **Öffentlichen Schlüssel eintragen:** Zeile
   `dvhub-release namespaces="dvhub-release,dvhub-release-index" <Inhalt von release_ed25519.pub>` in
   `release-keys/allowed_signers`, committen. Erst ab diesem Commit nehmen Boxen Pakete an.
4. **Erste Veröffentlichung** (Reihenfolge wichtig, sonst finden umstellungsbereite Boxen kein Paket):
   ```bash
   scripts/release/build-release.sh v1.0.9          # baut arm64, armhf, amd64 und signiert
   scripts/release/publish-release.sh ~/Projects/dvhub-release-out/1.0.9 --dry-run --dest /tmp/pub   # ansehen
   scripts/release/publish-release.sh ~/Projects/dvhub-release-out/1.0.9                               # GitHub
   scripts/release/build-release.sh main && scripts/release/publish-release.sh ~/Projects/dvhub-release-out/<dev-version>
   ```
   Danach den Tag wie gewohnt ausrollen: git-Boxen holen v1.0.9 per git und stellen sich nach ~2 min selbst um.

## Offene Entscheidungen

Siehe Abschnitt „Offen“ im Bericht zum Branch; die wichtigsten: Umgang mit eigener `--repo`-Quelle (Vorschlag oben),
ob Neuinstallationen direkt ein Paket ziehen sollen statt zu klonen, Aufbewahrung des alten Checkouts, Anzahl der
liegenbleibenden dev-Stände.
