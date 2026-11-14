#!/usr/bin/env python3
"""String-Kataloge der iPhone-App pflegen und prüfen.

  strings.py check                   Jede Zeichenkette hat eine englische Übersetzung (sonst Exit 1).
  strings.py apply <katalog> <json>  Englische Übersetzungen aus {Schlüssel: Text} eintragen.
  strings.py missing <katalog>       Schlüssel ohne englische Übersetzung als JSON ausgeben.

Ausgangssprache ist Deutsch: Der Schlüssel ist der deutsche Text. Neue
Schlüssel trägt Xcode beim Bauen selbst ein; von der Kommandozeile macht das
tools/sync-strings.sh.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CATALOGS = [
    ROOT / "DVhubApp/Shared/Localizable.xcstrings",
    ROOT / "DVhubApp/DVhubApp/InfoPlist.xcstrings",
    ROOT / "DVhubApp/DVhubApp/AppShortcuts.xcstrings",
    ROOT / "DVhubLink/Sources/DVhubLink/Resources/Localizable.xcstrings",
]


def load(path):
    return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))


def save(path, data):
    # Wie Xcode schreibt: zwei Leerzeichen, " : " als Trenner, Schlüssel sortiert.
    text = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True, separators=(",", " : "))
    pathlib.Path(path).write_text(text + "\n", encoding="utf-8")


def english(entry):
    """Englischer Text (oder Liste bei Kurzbefehl-Sätzen); None, wenn er fehlt."""
    loc = entry.get("localizations", {}).get("en")
    if not loc:
        return None
    if "stringUnit" in loc:
        unit = loc["stringUnit"]
        return unit.get("value") if unit.get("state") == "translated" else None
    if "stringSet" in loc:
        unit = loc["stringSet"]
        return unit.get("values") if unit.get("state") == "translated" else None
    return loc if "variations" in loc else None


def missing(path):
    data = load(path)
    return [k for k, v in sorted(data["strings"].items())
            if v.get("shouldTranslate", True) and v.get("extractionState") != "stale" and english(v) is None]


SPEC = re.compile(r"%(?:(\d+)\$)?(lld|ld|d|@|lf|f|s)")


def placeholders(text):
    """Platzhalter als sortierte Liste der Typen — Reihenfolge darf sich durch %1$@ ändern."""
    found = SPEC.findall(text.replace("%%", ""))
    if any(pos for pos, _ in found):
        return sorted(kind for _, kind in sorted(found, key=lambda f: int(f[0] or 0)))
    return sorted(kind for _, kind in found)


def mismatched(path):
    """Schlüssel, deren englischer Text andere Platzhalter hat als der deutsche."""
    out = []
    for key, entry in sorted(load(path)["strings"].items()):
        text = english(entry)
        texts = text if isinstance(text, list) else [text]
        for t in texts:
            if isinstance(t, str) and placeholders(t) != placeholders(key):
                out.append(key)
    return out


def apply(path, translations):
    data = load(path)
    unknown = []
    for key, text in translations.items():
        entry = data["strings"].get(key)
        if entry is None:
            unknown.append(key)
            continue
        entry.setdefault("localizations", {})["en"] = {"stringUnit": {"state": "translated", "value": text}}
    save(path, data)
    return unknown


def main(argv):
    if len(argv) >= 2 and argv[1] == "check":
        bad = 0
        for path in CATALOGS:
            if not path.exists():
                print(f"FEHLT   {path.relative_to(ROOT)}")
                bad += 1
                continue
            data = load(path)
            if data.get("sourceLanguage") != "de":
                print(f"FEHLER  {path.relative_to(ROOT)}: Ausgangssprache ist nicht Deutsch")
                bad += 1
            stale = [k for k, v in data["strings"].items() if v.get("extractionState") == "stale"]
            gaps = missing(path)
            print(f"{'ok' if not gaps and not stale else 'LÜCKE':7} {path.relative_to(ROOT)}: {len(data['strings'])} Texte, "
                  f"{len(gaps)} ohne Englisch, {len(stale)} verwaist")
            for key in gaps[:20]:
                print(f"          ohne Englisch: {key!r}")
            for key in stale[:20]:
                print(f"          verwaist: {key!r}")
            wrong = [] if path.name == "AppShortcuts.xcstrings" else mismatched(path)
            for key in wrong:
                print(f"          Platzhalter weichen ab: {key!r}")
            bad += len(gaps) + len(stale) + len(wrong)
        return 1 if bad else 0
    if len(argv) == 4 and argv[1] == "apply":
        unknown = apply(argv[2], load(argv[3]))
        for key in unknown:
            print(f"unbekannter Schlüssel: {key!r}")
        print(f"{len(missing(argv[2]))} ohne Englisch")
        return 0
    if len(argv) == 3 and argv[1] == "missing":
        print(json.dumps(missing(argv[2]), ensure_ascii=False, indent=0))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
