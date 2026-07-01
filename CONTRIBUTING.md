# Contributing

Contributions are welcome and appreciated.

By submitting a contribution to this repository you agree that:

1. You have the right to submit the contribution.
2. Your contribution may be distributed under the project's license
   (Energy Community License ECL-1.0).
3. The project maintainer may use, modify, and redistribute your
   contribution as part of the project.

---

## How to contribute

You can contribute by:

* reporting bugs
* suggesting features
* improving documentation
* submitting pull requests
* improving code quality

---

## Pull Request Guidelines

Please ensure that:

* code is well documented
* changes are clearly described
* unnecessary complexity is avoided
* changes are relevant to the project

---

## Frontend cache-buster convention

Every `<script src>`/`<link href>` in `dvhub/public/*.html` that points at a
project-owned `.js`/`.css` file carries a `?v=` query string so browsers pick
up the new file instead of serving a stale cached copy. Use
**`?v=YYYYMMDD-slug`** (short, present-tense slug describing the change), or
plain **`?v=YYYYMMDD`** for asset files that rarely change (icons, manifest).
Bump it on every change to that file — a missed bump means users silently
keep running old JS/CSS. Do not use bare incrementing integers (`?v=12`); that
format has caused several stale-cache incidents because it is easy to forget
whether the last bump was yours.

---

## Community

This project aims to support the **energy transition community**,
especially operators of renewable energy systems.
