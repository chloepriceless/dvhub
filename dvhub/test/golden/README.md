# Golden-Vektoren der reinen Split-/Planungs-Funktionen (S0)

Stufe **S0 „Bestand festschreiben“** der herstellergenerischen WR-Basis (Plan
`~/Projects/DVhub-hersteller-plan/.planning/hersteller-basis/UNIVERSELLE-SCHNITTSTELLE-PLAN.md`, §4.1/§4.2).

Diese Dateien frieren den **IST-Zustand** der reinen Funktionen aus
`services/inverter/sungrow.js`, `services/multi-gx/planning.js` und
`services/optimizer/grid-share-poll.js` als Eingang→Ausgang-Referenz ein. Sie ändern **keinen Produktcode**.
Grundlage für das spätere Herauslösen des Rechenkerns (S1) und die Rust-Parität (M3).

## Dateien

- `inverter-split/<funktion>.json` — eine Datei je erfasster Funktion.
- `generate-split-vectors.mjs` — Generator (deterministisch, ohne Zufall; zweimal ausführen → **byte-gleich**).
- `apply.mjs` — die **einzige** Aufrufkonvention; Generator und Test rufen die echten Funktionen nur hierüber auf,
  damit „erzeugt“ und „geprüft“ nicht auseinanderlaufen.
- `../golden-split-vectors.test.js` — prüft die heutigen Funktionen gegen die eingecheckten Vektoren.

## Erzeugen

```
cd dvhub && export PATH=/opt/homebrew/opt/node@22/bin:$PATH
node test/golden/generate-split-vectors.mjs
```

## JSON-Schema (`dvhub.golden-split/1`)

Je Datei ein Objekt. Das ist bewusst schlicht gehalten, damit der Rust-Vektorleser
(`dvhub-rs/crates/dvhub-drivers/tests/node_vectors.rs`, Muster `d["vectors"].as_array()` mit `v["input"]`/
`v["output"]`) es später **ohne Umbau** lesen kann:

```jsonc
{
  "function": "splitStrategyShares",   // Funktionsname
  "schema":   "dvhub.golden-split/1",
  "generator":"test/golden/generate-split-vectors.mjs",
  "count":    2023,                     // == vectors.length
  "now":      1794571200000,            // nur bei ctx-basierten Funktionen: fester Date.now()-Zeitpunkt
  "vectors": [
    { "name": "feld_9.2_14.4_entladen", "input": { ... }, "output": { ... } }
  ]
}
```

Zwei Eingangs-Formen:

1. **Reine Funktionen** (`splitStrategyShares`, `splitSungrowPower`, `socBalanceWeights`, `sungrowRealSocPct`,
   `sungrowDischargeFloorPct`, `sungrowChargeCeilPct`, `sungrowEffectivePowerW`, `decideEmsCommand`,
   `isSungrowEmergencyCharge`):
   `input = { "args": [ ... ] }` — die Positionsargumente. Aufruf: `fn(...args)`.

2. **ctx-basiert, aber deterministisch** (`planningCfg`, `planningSocPct`, `planningMinSocPct`,
   `gridShareCapacityInput`):
   `input = { "state": {...}, "cfg": {...}, "now": <ms>, "primaryMinSocPct"?: <n> }`.
   Der Test rekonstruiert `ctx = { state, getCfg: () => cfg }` und nagelt `Date.now()` auf `now` fest (die
   Planungs-/Netzanteil-Funktionen fragen in `secondInverterTelemetry` einen Frische-Zeitpunkt über `Date.now()`
   ab; mit festem `now` sind sie ein sauberer Eingang→Ausgang und reproduzierbar). Die Zeitstempel in `state`
   (z. B. `sungrowSecond.updatedAt`, `multiGx.updatedAt`) sind relativ zu diesem `now` gesetzt.

`output` ist das JSON-normierte Funktionsergebnis (−0 → 0, `undefined`-Felder entfallen). Der Test vergleicht
`JSON.parse(JSON.stringify(ergebnis))` gegen das gespeicherte `output` mit `deepStrictEqual`.

## Erfasste Funktionen und Pflicht-Feldfälle

Die benannten Feldfälle sind **einzeln und erkennbar** in den Vektoren enthalten (der Test erzwingt das):
9,2/14,4 % und 0,8/2,2 % (Angleich, Laden/Entladen), Notladung (`0x4001`), Slave offline, gemeldeter SoC 0 %
(= real = Gerätemin), Entlade-Boden je Einheit mit dem N1-Feldwert (hart 5, Gerätemin 10, Puffer 1 → 11 %).

Seit dem Neuerzeugen auf main 8e72f61b (24.11.) zusätzlich: M28 in `splitStrategyShares` (Ausgänge `masterOut`/
`slaveOut` = `'soc' | 'stalled' | null`, Eingänge `dischargeMarginPct`, `masterStalled`, `slaveStalled`; benannte
`m28_*`-Fälle plus Raster) und ein ausdrücklich eingetragener Puffer `sungrow.socFloorBufferPct = 1` in den
ctx-Fällen (`*_puffer1`). Ohne Eintrag gilt seit M24 (2c6c70d0) der Standard-Puffer 0 → Boden 10 statt 11 %.

## Nicht erfasst (gehört in die Schreibspur-Hälfte von S0)

Der Aktuator `createSungrowEms` (`sungrow.js:725-1998`) mit Besitz-Merker, Herzschlag, Schreibreihenfolge und
Rücklesen ist **keine reine Funktion** (Datei-I/O, Zeit, Modbus-Transport) und wird hier NICHT erfasst — er kommt
über die Schreibspur (write-trace) als separate S0-Hälfte.
