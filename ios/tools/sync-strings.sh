#!/bin/bash
# String-Kataloge mit dem Quelltext abgleichen — ohne Xcode-Oberfläche.
#
# Xcode trägt neue Texte beim Bauen in der Oberfläche selbst in die Kataloge
# ein; von der Kommandozeile tut `xcodebuild` das nicht. Dieses Skript macht
# dasselbe mit denselben Werkzeugen: Der Swift-Compiler schreibt je Datei die
# gefundenen Texte (.stringsdata), `xcstringstool sync` gleicht die Kataloge ab
# (neue Schlüssel dazu, nicht mehr verwendete als verwaist markiert bzw. entfernt).
# Danach: `python3 tools/strings.py check` zeigt, was noch ohne Englisch ist.
set -euo pipefail
cd "$(dirname "$0")/.."
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
FLAGS=(-sdk "$SDK" -target arm64-apple-ios18.0-simulator -swift-version 5 -D DEBUG -emit-localized-strings)
mkdir -p "$TMP/pkg" "$TMP/app" "$TMP/wid" "$TMP/obj"

# Paket: Modul für die App-Übersetzung und Texte des Pakets.
printf 'import Foundation\nextension Bundle { static var module: Bundle { .main } }\n' > "$TMP/BundleModule.swift"
(cd "$TMP/obj" && xcrun swiftc "${FLAGS[@]}" -emit-localized-strings-path "$TMP/pkg" -parse-as-library -module-name DVhubLink \
  -emit-module -emit-module-path "$TMP/DVhubLink.swiftmodule" -c "$OLDPWD"/DVhubLink/Sources/DVhubLink/*.swift "$TMP/BundleModule.swift")
rm -f "$TMP/pkg/BundleModule.stringsdata"

# App und Widget-Erweiterung (Shared/ gehört beiden).
(cd "$TMP/obj" && xcrun swiftc "${FLAGS[@]}" -emit-localized-strings-path "$TMP/app" -I "$TMP" -module-name DVhub -c \
  $(find "$OLDPWD/DVhubApp/DVhubApp" "$OLDPWD/DVhubApp/Shared" -name '*.swift'))
(cd "$TMP/obj" && xcrun swiftc "${FLAGS[@]}" -emit-localized-strings-path "$TMP/wid" -I "$TMP" -application-extension -module-name DVhubWidgets -c \
  $(find "$OLDPWD/DVhubApp/DVhubWidgets" "$OLDPWD/DVhubApp/Shared" -name '*.swift'))

xcrun xcstringstool sync DVhubLink/Sources/DVhubLink/Resources/Localizable.xcstrings --stringsdata "$TMP"/pkg/*.stringsdata
xcrun xcstringstool sync DVhubApp/Shared/Localizable.xcstrings --stringsdata "$TMP"/app/*.stringsdata "$TMP"/wid/*.stringsdata
python3 tools/strings.py check || true
