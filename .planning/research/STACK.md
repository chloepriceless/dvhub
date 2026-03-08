# Stack Research

**Domain:** Brownfield Node.js control webapp with settings-heavy beginner UX
**Researched:** 2026-03-08
**Confidence:** HIGH

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Node.js | 24.x LTS preferred, 22.x LTS acceptable during transition | Runtime for the existing single-process app | PlexLite already runs as native Node ESM with no build step. Standardizing on modern LTS keeps the current deployment model intact while removing the risk of the repo's outdated `>=18` engine floor. |
| Native Node.js modules (`http`, `net`, `fs`, `fetch`, `node:test`) | Built into current LTS | HTTP API, Modbus server, file persistence, tests | The current backend already uses Node core directly. For this project, the bottleneck is UX and code organization, not missing server framework features. Keep the platform small and refactor internally first. |
| Multi-page HTML/CSS/JavaScript | Standards-based, no SPA framework | Dashboard, setup wizard, settings, tools | The repo already ships page-oriented UI under `dv-control-webapp/public/`. That matches the UX goal: guided setup, compact settings, and progressive disclosure can be delivered with native web primitives instead of a framework rewrite. |
| Native browser UI primitives (`<details>`, `<dialog>`, HTML constraint validation) | Current evergreen browsers | Progressive disclosure, confirmations, step validation | PlexLite's settings page already renders grouped `<details>` sections. Leaning further into built-in disclosure, modal, and validation features is the lowest-risk path to a clearer beginner experience. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `mqtt` | Keep on tested 5.x line | Victron MQTT transport | Keep the existing optional dependency. It is already integrated and does not justify replacement during a UX-focused milestone. |
| `@playwright/test` | Current stable | Browser-level regression coverage for setup/settings flows | Add this first if the team changes setup, navigation, disclosure defaults, import/export, or restart-warning flows. It gives confidence without changing production architecture. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `node:test` | Unit and integration tests for config normalization, restart detection, auth checks, and API payload handling | Prefer this over adding another JS test framework first. It keeps the toolchain aligned with the current zero-build approach. |
| Playwright | End-to-end coverage for `setup.html`, `settings.html`, and critical admin flows | Focus on beginner journeys: first-run setup, save/reload, advanced section expansion, import/export, and restart-required messaging. |
| npm scripts only | Lightweight project automation | Keep scripts explicit and small. This repo does not currently need Vite, Webpack, or a task-runner migration just to improve settings UX. |

## Installation

```bash
cd /Volumes/My Shared Files/CODEX/Plexlite/dv-control-webapp

# Runtime
npm install

# Minimal test additions worth making for this repo
npm install -D @playwright/test
npx playwright install --with-deps
```

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Multi-page vanilla HTML/CSS/JS | React/Vue SPA | Only if PlexLite later needs complex client-side state shared across many screens, offline-first behavior, or a reusable component system that clearly outweighs migration risk. That is not this project's problem today. |
| Native Node `http` plus internal module splits | Express/Fastify | Use only if route/middleware complexity becomes the real constraint after `server.js` is modularized. Do not introduce a framework just because the main file is large. |
| `node:test` + Playwright | Vitest/Cypress/Jest | Use an alternative only if the team already has strong existing expertise or shared tooling elsewhere. For this repo alone, built-in tests plus Playwright are the smallest effective addition. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Full SPA rewrite | It adds a bundler, client-side state layer, migration churn, and high regression risk without solving the actual problem: clearer information architecture for setup/settings. | Keep the current multi-page app and improve structure, disclosure, labels, and validation in place. |
| Heavy client form/state libraries | They duplicate browser capabilities and usually force a framework decision. PlexLite already has a server-backed config definition and page-specific JS. | Use native forms, browser validation, and the existing config-model metadata. |
| TypeScript migration as a prerequisite to UX work | It is a large cross-cutting change across `server.js`, `config-model.js`, and browser scripts, with low immediate UX payoff. | First add tests and split large files into smaller JS modules. Reassess typing later if maintenance still hurts. |
| New CDN/runtime dependencies for core UX | PlexLite is deployed locally and should stay resilient even on restricted or flaky internet connections. | Prefer self-hosted assets and zero-build browser features; even the current Google Fonts usage should be treated as optional, not foundational. |
| Query-string plus `localStorage` token persistence as the long-term auth UX | It leaks secrets into URLs, browser history, and persistent client storage. | Move toward bearer-header-only flows or a server-managed session/bootstrap pattern when auth UX is revisited. |

## Stack Patterns by Variant

**If the goal is the current milestone: simpler setup and settings UX**
- Keep `dv-control-webapp/public/setup.html` and `dv-control-webapp/public/settings.html` as separate entry points.
- Keep vanilla JS and move complexity into small helper modules rather than a framework.
- Use native `<details>` groups for advanced and expert sections, defaulting beginner fields open and expert fields closed.
- Use native `<dialog>` for destructive actions, restart confirmations, import warnings, and expert-only explanations.
- Use HTML validation attributes plus `checkValidity()` and `reportValidity()` before config POSTs.
- Add Playwright coverage for first-run setup and settings save flows before broad UI rework.

**If the goal is maintainability after the UX pass**
- Split `dv-control-webapp/server.js` into route, control, polling, and integration modules without changing the external deployment model.
- Split `settings.js` into schema-to-form rendering helpers, form serialization, and admin actions.
- Keep API shapes stable while refactoring. Do not pair a server refactor with a frontend rewrite in the same phase.

**If PlexLite must support low-connectivity or semi-offline installs**
- Avoid adding any frontend build step that must fetch packages during deployment.
- Self-host fonts or switch to a local system font stack so setup still renders well without external font CDNs.
- Preserve direct `npm start` and systemd deployment simplicity.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `node@24.x` | `mqtt@5.x` | Preferred target after validation. Current repo architecture is already modern ESM and should stay on supported LTS. |
| `node@22.x` | `mqtt@5.x` | Safe transition target because the installer already provisions Node 22. |
| `node@18.x` | Not recommended | Node 18 is past end-of-life and should not remain the declared compatibility floor. |
| `@playwright/test@current` | `node@22.x` or `node@24.x` | Good fit for browser regression coverage without introducing a production dependency. |

## Repo-Specific Guidance

- Keep the current stack. PlexLite is already close to the right architecture for this milestone: small Node backend, static pages, shared config model, and browser-native UI.
- Do not treat the size of `server.js` or `settings.js` as evidence that a framework rewrite is needed. It is evidence that module boundaries and tests are needed.
- The biggest stack-level improvement is standardization, not replacement:
  - standardize the runtime on supported Node LTS
  - standardize beginner UX on native disclosure, dialog, and validation patterns
  - standardize regression coverage with `node:test` and Playwright
- Only add another library when it removes clear risk. For this repo, Playwright is the strongest minimal addition. A client framework is not.

## Sources

- [Node.js official release schedule](https://nodejs.org/en/about/previous-releases) - verified supported LTS lines and that Node 18 should not remain the floor.
- [Node.js ECMAScript modules docs](https://nodejs.org/api/esm.html) - confirmed the platform support PlexLite already relies on.
- [Node.js test runner docs](https://nodejs.org/api/test.html) - verified built-in testing is viable without adding a separate unit test framework first.
- [MDN: `<details>` element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/details) - confirmed native disclosure patterns suitable for advanced/expert settings sections.
- [MDN: `<dialog>` element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog) - confirmed native modal support for confirmations and guided messaging.
- [MDN: Client-side form validation](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Forms/Form_validation) - confirmed native validation is sufficient for beginner-focused setup flows.
- [Playwright official introduction](https://playwright.dev/docs/intro) - verified the recommended browser-testing tool for setup/settings regression coverage.

---
*Stack research for: PlexLite settings/setup UX improvements*
*Researched: 2026-03-08*
