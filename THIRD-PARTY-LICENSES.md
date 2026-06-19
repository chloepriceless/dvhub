# Third-Party Licenses — Lizenzhinweise Dritter

> Attributionsdatei für DVhub. Stand: 2026-06-19 · DVhub-Version 1.0.0

DVhub selbst steht unter der **Energy Community License (ECL-1.0)** — siehe
[`LICENSE.md`](LICENSE.md). Diese Datei erfüllt die **Attributionspflicht** der
darin verwendeten Software Dritter: jede der unten gelisteten Komponenten verlangt
bei Weitergabe, dass ihr Copyright-Hinweis und Lizenztext mitgeliefert werden.

**Ergebnis des Lizenz-Audits:** Der gesamte in DVhub *eingebundene* Code
(npm-, Python- und Frontend-Pakete) steht ausschließlich unter **permissiven**
Lizenzen (MIT, Apache-2.0, ISC, BSD-3-Clause, 0BSD). Es gibt **kein Copyleft**
(kein GPL/LGPL/AGPL/MPL) im ausgelieferten Code. Damit ist die kommerzielle
Weitergabe — auch als Closed-Source-Produkt — zulässig, ohne dass DVhub-eigener
Quellcode offengelegt werden muss. Einzige Pflicht: diese Attributionsdatei
mitliefern. Hinweise zu copyleft-lizenzierter *Systemsoftware* (OpenVPN,
WireGuard, strongSwan) und zur Timescale License siehe Abschnitt 4.

## Übersicht — npm-Abhängigkeiten

| Lizenz | Pakete | Eigenschaft |
|---|---|---|
| MIT | 113 | permissiv |
| Apache-2.0 | 54 | permissiv (+ Patentgewährung, NOTICE) |
| ISC | 9 | permissiv |
| BSD-3-Clause | 2 | permissiv |
| 0BSD | 1 | permissiv (ohne Attributionspflicht) |
| **Summe** | **179** | (direkte + transitive Abhängigkeiten, dedupliziert nach Paket@Version) |

Davon sind 10 direkte Produktiv-Abhängigkeiten (`@dsnp/parquetjs`, `aedes`,
`franc`, `highs`, `mqtt`, `multicast-dns`, `p-retry`, `pg`, `pg-cursor`,
`prom-client`); der Rest sind transitive Abhängigkeiten. Diese Liste enthält
ausschließlich Produktiv-Abhängigkeiten (`npx license-checker --production`);
reine devDependencies (z. B. `@playwright/test`) werden **nicht** mit dem
Produkt ausgeliefert und sind hier folgerichtig **nicht** gelistet.

---

## 1. npm-Pakete

### 1.1 MIT (113)

| Paket | Version | Copyright / Rechteinhaber |
|---|---|---|
| `@babel/runtime` | 7.29.2 | Copyright (c) 2014-present Sebastian McKenzie and other contributors |
| `@dsnp/parquetjs` | 1.8.7 | Copyright for portions of the project are (c) 2017 ironSource Ltd. https://github.com/ironSource/parquetjs; Copyright for portions of the project are https://github.com/ZJONSSON/parquetjs |
| `@leichtgewicht/ip-codec` | 2.0.5 | Copyright (c) 2021 Martin Heidegger |
| `@nodable/entities` | 2.1.0 | Amit Gupta (https://solothought.com) |
| `@types/node` | 22.19.19 | Copyright (c) Microsoft Corporation. |
| `@types/node` | 25.6.0 | Copyright (c) Microsoft Corporation. |
| `@types/node-int64` | 0.4.32 | Copyright (c) Microsoft Corporation. |
| `@types/q` | 1.5.8 | Copyright (c) Microsoft Corporation. |
| `@types/readable-stream` | 4.0.23 | Copyright (c) Microsoft Corporation. |
| `@types/thrift` | 0.10.17 | Copyright (c) Microsoft Corporation. |
| `@types/ws` | 8.18.1 | Copyright (c) Microsoft Corporation. |
| `@xterm/xterm` | 5.5.0 | Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js); Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com) |
| `@zenfs/core` | 1.11.4 | Copyright (c) James Prevett and other ZenFS contributors.; Copyright (c) 2013-2023 John Vilk and other BrowserFS contributors. |
| `abort-controller` | 3.0.0 | Copyright (c) 2017 Toru Nagashima |
| `aedes` | 0.51.3 | Copyright (c) Aedes Contributors; Copyright (c) 2015-2020 Matteo Collina, http://matteocollina.com |
| `aedes-packet` | 3.0.0 | Copyright (c) Aedes Contributors; Copyright (c) 2015-2020 Matteo Collina, http://matteocollina.com |
| `aedes-persistence` | 9.1.2 | Copyright (c) Aedes Contributors; Copyright (c) 2015-2020 Matteo Collina, http://matteocollina.com |
| `async-limiter` | 1.0.1 | Copyright (c) 2017 Samuel Reed <samuel.trace.reed@gmail.com> |
| `base64-js` | 1.5.1 | Copyright (c) 2014 Jameson Little |
| `bintrees` | 1.0.2 | Copyright (C) 2011 by Vadim Graboys |
| `bl` | 4.1.0 | Copyright (c) 2013-2019 bl contributors |
| `bl` | 6.1.6 | Copyright (c) 2013-2019 bl contributors |
| `bowser` | 2.14.1 | Copyright 2015, Dustin Diaz (the "Original Author") |
| `broker-factory` | 3.1.14 | Copyright (c) 2026 Christoph Guttandin |
| `browser-or-node` | 1.3.0 | Copyright (c) 2018 Dineshkumar Pandiyan <flexdinesh@gmail.com> |
| `buffer` | 5.7.1 | Copyright (c) Feross Aboukhadijeh, and other contributors. |
| `buffer` | 6.0.3 | Copyright (c) Feross Aboukhadijeh, and other contributors. |
| `buffer-from` | 1.1.2 | Copyright (c) 2016, 2018 Linus Unnebäck |
| `collapse-white-space` | 2.1.0 | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| `commist` | 3.2.0 | Copyright (c) 2014-2022 Matteo Collina |
| `concat-stream` | 2.0.0 | Copyright (c) 2013 Max Ogden |
| `debug` | 4.4.3 | Copyright (c) 2014-2017 TJ Holowaychuk <tj@vision-media.ca>; Copyright (c) 2018-2021 Josh Junon |
| `dns-packet` | 5.6.1 | Copyright (c) 2016 Mathias Buus |
| `end-of-stream` | 1.4.5 | Copyright (c) 2014 Mathias Buus |
| `event-target-shim` | 5.0.1 | Copyright (c) 2015 Toru Nagashima |
| `eventemitter3` | 5.0.4 | Copyright (c) 2014 Arnout Kazemier |
| `events` | 3.3.0 | Copyright Joyent, Inc. and other Node contributors. |
| `fast-unique-numbers` | 8.0.13 | Copyright (c) 2023 Christoph Guttandin |
| `fast-unique-numbers` | 9.0.27 | Copyright (c) 2026 Christoph Guttandin |
| `fast-xml-builder` | 1.2.0 | Copyright (c) 2026 Natural Intelligence |
| `fast-xml-parser` | 5.7.3 | Copyright (c) 2017 Amit Kumar Gupta |
| `fastfall` | 1.5.1 | Copyright (c) 2015 Matteo Collina |
| `franc` | 6.2.0 | Titus Wormer <tituswormer@gmail.com> (http://wooorm.com) |
| `help-me` | 5.0.0 | Copyright (c) 2014-2022 Matteo Collina |
| `highs` | 1.8.0 | Copyright (c) 2023 highs-js |
| `hyperid` | 3.3.0 | Copyright (c) 2016 Matteo Collina |
| `ip-address` | 10.1.0 | Copyright (C) 2011 by Beau Gunderson |
| `is-network-error` | 1.3.1 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |
| `isomorphic-ws` | 4.0.1 | Copyright (c) 2018 Zejin Zhuang <heineiuo@gmail.com> |
| `js-sdsl` | 4.3.0 | Copyright (c) 2021 Zilong Yao |
| `minimist` | 1.2.8 | James Halliday |
| `mqtt` | 5.15.1 | Copyright (c) 2015-2016 MQTT.js contributors; Copyright 2011-2014 by Adam Rudd |
| `mqtt-packet` | 7.1.2 | Copyright (c) 2014-2017 mqtt-packet contributors |
| `mqtt-packet` | 9.0.2 | Copyright (c) 2014-2017 mqtt-packet contributors |
| `ms` | 2.1.3 | Copyright (c) 2020 Vercel, Inc. |
| `multicast-dns` | 7.2.5 | Copyright (c) 2015 Mathias Buus |
| `n-gram` | 2.0.2 | Copyright (c) 2014 Titus Wormer <tituswormer@gmail.com> |
| `node-int64` | 0.4.0 | Copyright (c) 2014 Robert Kieffer |
| `number-allocator` | 1.0.14 | Copyright (c) 2021 Takatoshi Kondo |
| `p-retry` | 8.0.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |
| `path-expression-matcher` | 1.5.0 | Copyright (c) 2024 |
| `pg` | 8.20.0 | Copyright (c) 2010 - 2021 Brian Carlson |
| `pg-cloudflare` | 1.3.0 | Copyright (c) 2010 - 2021 Brian Carlson |
| `pg-connection-string` | 2.12.0 | Copyright (c) 2014 Iced Development |
| `pg-cursor` | 2.19.0 | Copyright (c) 2010 - 2021 Brian Carlson |
| `pg-pool` | 3.13.0 | Copyright (c) 2017 Brian M. Carlson |
| `pg-protocol` | 1.13.0 | Copyright (c) 2010 - 2021 Brian Carlson |
| `pg-types` | 2.2.0 | Brian M. Carlson |
| `pgpass` | 1.0.5 | Hannes Hörl <hannes.hoerl+pgpass@snowreporter.com> |
| `postgres-array` | 2.0.0 | Copyright (c) Ben Drucker <bvdrucker@gmail.com> (bendrucker.me) |
| `postgres-bytea` | 1.0.1 | Copyright (c) Ben Drucker <bvdrucker@gmail.com> (bendrucker.me) |
| `postgres-date` | 1.0.7 | Copyright (c) Ben Drucker <bvdrucker@gmail.com> (bendrucker.me) |
| `postgres-interval` | 1.2.0 | Copyright (c) Ben Drucker <bvdrucker@gmail.com> (bendrucker.me) |
| `process` | 0.11.10 | Copyright (c) 2013 Roman Shtylman <shtylman@gmail.com> |
| `process-nextick-args` | 2.0.1 | Copyright (c) 2015 Calvin Metcalf |
| `q` | 1.5.1 | Copyright 2009–2017 Kristopher Michael Kowal. All rights reserved. |
| `qlobber` | 7.0.1 | Copyright (c) 2016 David Halls <https://github.com/davedoesdev/> |
| `qlobber` | 8.0.1 | Copyright (c) 2016 David Halls <https://github.com/davedoesdev/> |
| `readable-stream` | 3.6.2 | Copyright Node.js contributors. All rights reserved.; Copyright Joyent, Inc. and other Node contributors. All rights reserved. |
| `readable-stream` | 4.7.0 | Copyright Node.js contributors. All rights reserved.; Copyright Joyent, Inc. and other Node contributors. All rights reserved. |
| `retimer` | 4.0.0 | Copyright (c) 2015 Matteo Collina |
| `reusify` | 1.1.0 | Copyright (c) 2015-2024 Matteo Collina |
| `rfdc` | 1.4.1 | Copyright 2019 "David Mark Clements <david.mark.clements@gmail.com>" |
| `safe-buffer` | 5.2.1 | Copyright (c) Feross Aboukhadijeh |
| `smart-buffer` | 4.2.0 | Copyright (c) 2013-2017 Josh Glazebrook |
| `snappyjs` | 0.7.0 | Copyright (c) 2016 Zhipeng Jia |
| `socks` | 2.8.7 | Copyright (c) 2013 Josh Glazebrook |
| `string_decoder` | 1.3.0 | Copyright Node.js contributors. All rights reserved.; Copyright Joyent, Inc. and other Node contributors. All rights reserved. |
| `strnum` | 2.3.0 | Copyright (c) 2021 Natural Intelligence |
| `tdigest` | 0.1.2 | Copyright (c) 2015 Will Welch |
| `thunky` | 1.1.0 | Copyright (c) 2018 Mathias Buus |
| `trigram-utils` | 2.0.1 | Copyright (c) 2014 Titus Wormer <tituswormer@gmail.com> |
| `typedarray` | 0.0.6 | Copyright (c) 2010, Linden Research, Inc.; Copyright (c) 2012, Joshua Bell |
| `undici-types` | 6.21.0 | Copyright (c) Matteo Collina and Undici contributors |
| `undici-types` | 7.19.2 | Copyright (c) Matteo Collina and Undici contributors |
| `util-deprecate` | 1.0.2 | Copyright (c) 2014 Nathan Rajlich <nathan@tootallnate.net> |
| `utilium` | 1.10.1 | James Prevett <jp@jamespre.dev> (https://jamespre.dev) |
| `uuid` | 10.0.0 | Copyright (c) 2010-2020 Robert Kieffer and other contributors |
| `uuid` | 8.3.2 | Copyright (c) 2010-2020 Robert Kieffer and other contributors |
| `uuid-parse` | 1.1.0 | Copyright (c) 2010-2012 Robert Kieffer |
| `varint` | 6.0.0 | Chris Dickinson <chris@neversaw.us> |
| `worker-factory` | 7.0.49 | Copyright (c) 2026 Christoph Guttandin |
| `worker-timers` | 7.1.8 | Copyright (c) 2024 Christoph Guttandin |
| `worker-timers` | 8.0.31 | Copyright (c) 2026 Christoph Guttandin |
| `worker-timers-broker` | 6.1.8 | Copyright (c) 2024 Christoph Guttandin |
| `worker-timers-broker` | 8.0.16 | Copyright (c) 2026 Christoph Guttandin |
| `worker-timers-worker` | 7.0.71 | Copyright (c) 2024 Christoph Guttandin |
| `worker-timers-worker` | 9.0.14 | Copyright (c) 2026 Christoph Guttandin |
| `ws` | 5.2.4 | Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com> |
| `ws` | 8.20.0 | Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>; Copyright (c) 2013 Arnout Kazemier and contributors |
| `xml-naming` | 0.1.0 | Amit Gupta (https://solothought.com) |
| `xtend` | 4.0.2 | Copyright (c) 2012-2014 Raynos. |
| `xxhash-wasm` | 1.1.0 | Copyright © 2017 Michael Jungo |

### 1.2 Apache-2.0 (54)

Apache-2.0-Pakete gewähren zusätzlich eine Patentlizenz und verlangen, dass
Änderungen gekennzeichnet und vorhandene NOTICE-Dateien weitergegeben werden.
Der Großteil dieser Pakete (AWS SDK / Smithy) wird transitiv über
`@dsnp/parquetjs` (Parquet-Export mit optionaler S3-Unterstützung) gezogen.

| Paket | Version | Copyright / Rechteinhaber |
|---|---|---|
| `@aws-crypto/crc32` | 5.2.0 | Amazon.com, Inc. or its affiliates |
| `@aws-crypto/crc32c` | 5.2.0 | Amazon.com, Inc. or its affiliates |
| `@aws-crypto/sha1-browser` | 5.2.0 | Amazon.com, Inc. or its affiliates |
| `@aws-crypto/sha256-browser` | 5.2.0 | Amazon.com, Inc. or its affiliates |
| `@aws-crypto/sha256-js` | 5.2.0 | Amazon.com, Inc. or its affiliates |
| `@aws-crypto/supports-web-crypto` | 5.2.0 | Amazon.com, Inc. or its affiliates |
| `@aws-crypto/util` | 5.2.0 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/client-s3` | 3.1047.0 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/core` | 3.974.10 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/crc64-nvme` | 3.972.8 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/credential-provider-env` | 3.972.36 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/credential-provider-http` | 3.972.38 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/credential-provider-ini` | 3.972.40 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/credential-provider-login` | 3.972.40 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/credential-provider-node` | 3.972.41 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/credential-provider-process` | 3.972.36 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/credential-provider-sso` | 3.972.40 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/credential-provider-web-identity` | 3.972.40 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/middleware-bucket-endpoint` | 3.972.12 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/middleware-expect-continue` | 3.972.11 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/middleware-flexible-checksums` | 3.974.18 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/middleware-host-header` | 3.972.11 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/middleware-location-constraint` | 3.972.10 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/middleware-logger` | 3.972.10 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/middleware-recursion-detection` | 3.972.12 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/middleware-sdk-s3` | 3.972.39 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/middleware-ssec` | 3.972.10 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/middleware-user-agent` | 3.972.40 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/nested-clients` | 3.997.8 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/region-config-resolver` | 3.972.14 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/signature-v4-multi-region` | 3.996.26 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/token-providers` | 3.1047.0 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/types` | 3.973.8 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/util-endpoints` | 3.996.9 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/util-locate-window` | 3.965.5 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/util-user-agent-browser` | 3.972.11 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/util-user-agent-node` | 3.973.26 | Amazon.com, Inc. or its affiliates |
| `@aws-sdk/xml-builder` | 3.972.24 | Amazon.com, Inc. or its affiliates |
| `@aws/lambda-invoke-store` | 0.2.4 | Amazon.com, Inc. or its affiliates |
| `@opentelemetry/api` | 1.9.1 | OpenTelemetry Authors |
| `@smithy/core` | 3.24.2 | Amazon.com, Inc. or its affiliates |
| `@smithy/credential-provider-imds` | 4.3.2 | Amazon.com, Inc. or its affiliates |
| `@smithy/fetch-http-handler` | 5.4.2 | Amazon.com, Inc. or its affiliates |
| `@smithy/is-array-buffer` | 2.2.0 | Amazon.com, Inc. or its affiliates |
| `@smithy/node-http-handler` | 4.7.2 | Amazon.com, Inc. or its affiliates |
| `@smithy/signature-v4` | 5.4.2 | Amazon.com, Inc. or its affiliates |
| `@smithy/types` | 4.14.1 | Amazon.com, Inc. or its affiliates |
| `@smithy/util-buffer-from` | 2.2.0 | Amazon.com, Inc. or its affiliates |
| `@smithy/util-utf8` | 2.3.0 | Amazon.com, Inc. or its affiliates |
| `brotli-wasm` | 3.0.1 | Tim Perry / HTTP Toolkit |
| `bson` | 6.10.3 | MongoDB, Inc. |
| `long` | 5.3.2 | Daniel Wirtz |
| `prom-client` | 15.1.3 | Simon Nyberg and contributors |
| `thrift` | 0.21.0 | The Apache Software Foundation |

### 1.3 ISC (9)

| Paket | Version | Copyright / Rechteinhaber |
|---|---|---|
| `fastparallel` | 2.4.1 | Copyright (c) 2015, Matteo Collina <matteo.collina@gmail.com> |
| `fastseries` | 2.0.0 | Copyright (c) 2015, Matteo Collina <matteo.collina@gmail.com> |
| `inherits` | 2.0.4 | Copyright (c) Isaac Z. Schlueter |
| `lru-cache` | 10.4.3 | Copyright (c) 2010-2023 Isaac Z. Schlueter and Contributors |
| `mqemitter` | 6.0.2 | Copyright (c) 2014-2020, Matteo Collina <hello@matteocollina.com> |
| `once` | 1.4.0 | Copyright (c) Isaac Z. Schlueter and Contributors |
| `pg-int8` | 1.0.1 | Copyright © 2017, Charmander <~@charmander.me> |
| `split2` | 4.2.0 | Copyright (c) 2014-2018, Matteo Collina <hello@matteocollina.com> |
| `wrappy` | 1.0.2 | Copyright (c) Isaac Z. Schlueter and Contributors |

### 1.4 BSD-3-Clause (2)

| Paket | Version | Copyright / Rechteinhaber |
|---|---|---|
| `ieee754` | 1.2.1 | Copyright 2008 Fair Oaks Labs, Inc. |
| `int53` | 1.0.0 | Danny Coates <dannycoates@gmail.com> |

### 1.5 0BSD (1)

| Paket | Version | Copyright / Rechteinhaber |
|---|---|---|
| `tslib` | 2.8.1 | Copyright (c) Microsoft Corporation. |

---

## 2. Python-Pakete (server-seitige Prognose / ML)

Wird über `dvhub/python/requirements.txt` in eine virtuelle Umgebung installiert
(läuft als separater Prozess via `python-bridge`, nicht in den Node.js-Code
eingebunden).

| Paket | Lizenz | Rechteinhaber |
|---|---|---|
| pvlib | BSD-3-Clause | pvlib python Developers |
| pandas | BSD-3-Clause | AQR Capital Management, Lambda Foundry, PyData Development Team, pandas Development Team |
| scikit-learn | BSD-3-Clause | The scikit-learn developers |
| joblib | BSD-3-Clause | Gael Varoquaux and the joblib developers |
| lightgbm | MIT | Microsoft Corporation |
| statsforecast | Apache-2.0 | Nixtla |

Alle permissiv — kommerzielle Nutzung und Weitergabe uneingeschränkt zulässig.

---

## 3. Frontend-Bibliotheken (gevendort in `dvhub/public/`)

Als minifizierte Dateien direkt im Repo abgelegt und an den Browser ausgeliefert.

| Datei | Bibliothek | Version | Lizenz | Rechteinhaber |
|---|---|---|---|---|
| `chart.min.js` | Chart.js | 4.4.7 | MIT | Chart.js Contributors |
| `chartjs-plugin-zoom.min.js` | chartjs-plugin-zoom | 2.2.0 | MIT | chartjs-plugin-zoom Contributors |
| `chartjs-plugin-annotation.min.js` | chartjs-plugin-annotation | 3.1.0 | MIT | chartjs-plugin-annotation Contributors |
| `chartjs-chart-sankey.min.js` | chartjs-chart-sankey | 0.12.1 | MIT | Jukka Kurkela |
| `chartjs-chart-matrix.min.js` | chartjs-chart-matrix | (dev build) | MIT | Jukka Kurkela |
| `hammer.min.js` | Hammer.js | 2.0.7 | MIT | Jorik Tangelder |

Alle MIT — Lizenztext siehe Abschnitt 5.1.

---

## 4. Laufzeit- und Systemsoftware

Diese Software wird **nicht** in den DVhub-Code eingebunden, sondern als
separater Prozess / Betriebssystemdienst betrieben. Sie wird vom Installer
(`install.sh`) über den Paketmanager (`apt-get`) installiert bzw. nachgeladen.

| Software | Lizenz | Lizenztyp | Hinweis für die kommerzielle Weitergabe |
|---|---|---|---|
| Node.js 22 | MIT (+ permissive Komponenten) | permissiv | unkritisch |
| PostgreSQL | PostgreSQL License | permissiv (BSD-/MIT-artig) | unkritisch |
| TimescaleDB (optional, Migration 014) | Apache-2.0 (Kern) + **Timescale License / TSL** (Continuous Aggregates, Compression, Retention) | source-available, **nicht** OSI | erlaubt: Self-Hosting im Produkt. Verboten: TimescaleDB **als gehosteten Datenbank-Service (DBaaS)** anbieten. |
| OpenVPN | **GPL-2.0** | Copyleft | separater Prozess → kein abgeleitetes Werk, **keine** Offenlegung von DVhub-Code. Bei Auslieferung eines Images mit vorinstalliertem OpenVPN: Quellangebot für *OpenVPN* (Debian-Quellpaket). |
| WireGuard (`wireguard-tools`) | **GPL-2.0** | Copyleft | wie OpenVPN |
| strongSwan | **GPL-2.0+** | Copyleft | wie OpenVPN |
| Ollama (Tier 3, optional) | MIT | permissiv | per `install.sh` mit gepinnter SHA-256 nachgeladen |
| TinyLlama (LLM-Modell, Tier 3) | Apache-2.0 | permissiv | kommerzielle Nutzung erlaubt |
| Akkudoktor-EOS v0.3.0 (Tier 3, optional) | Apache-2.0 | permissiv | eigener systemd-Dienst auf 127.0.0.1:8503 |

**Kernaussage zum Copyleft:** OpenVPN, WireGuard und strongSwan sind die
einzigen Copyleft-Komponenten. Da DVhub sie ausschließlich als getrennte
Prozesse ansteuert (kein Linken, kein Einbinden von Quellcode), entsteht **kein
abgeleitetes Werk** — die GPL-Pflicht zur Quelloffenlegung greift für
DVhub-eigenen Code **nicht**. Solange `install.sh` diese Pakete nur per
`apt-get` auf dem Zielsystem installiert, verteilt DVhub sie nicht selbst und
löst auch deren GPL-Weitergabepflicht nicht aus.

---

## 5. Lizenztexte

### 5.1 MIT License

Gilt für alle in Abschnitt 1.1, 2 und 3 mit "MIT" gekennzeichneten Komponenten,
jeweils mit dem dort genannten Copyright-Hinweis.

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 5.2 ISC License

```
ISC License

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### 5.3 BSD 3-Clause License

```
BSD 3-Clause License

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### 5.4 BSD Zero Clause License (0BSD)

```
BSD Zero Clause License (0BSD)

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### 5.5 Apache License 2.0

Gilt für alle in Abschnitt 1.2 gelisteten Pakete sowie für `statsforecast`,
TinyLlama und Akkudoktor-EOS.

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
```

---

*Erzeugt am 2026-06-19 aus `dvhub/node_modules` (npm), `dvhub/python/requirements.txt`
(Python), `dvhub/public/` (Frontend) und `install.sh` (Systemsoftware).
Bei Änderungen an den Abhängigkeiten ist diese Datei zu aktualisieren —
empfohlenes Werkzeug: `npx license-checker --production`.*
