// eslint.config.js — Quality-Review 2026-07-01 follow-up.
//
// Minimal, high-signal ruleset (no stylistic/formatting rules — this is not a
// Prettier replacement). Backend runs under strict rules everywhere. Frontend
// runs under the same rules EXCEPT no-var, which stays off for the handful of
// legacy classic-script files that pre-date the project's const/let convention
// (app.js and everything written since already uses none) — flipping no-var
// on for them would be a multi-thousand-line mechanical rewrite with no
// behavioural payoff; migrate them incrementally when actually touched
// (see .planning/QUALITY-REVIEW-2026-07-01.md item 8).
import js from '@eslint/js';
import globals from 'globals';

const LEGACY_VAR_FILES = [
  'public/family.js',
  'public/integrations.js',
  'public/leitstand-charts.js',
  'public/settings.js',
  'public/pro-modal.js',
  'public/dv-modal.js',
  'public/common.js',
  'public/family-screensaver-logic.js',
];

const baseRules = {
  ...js.configs.recommended.rules,
  'no-var': 'error',
  'prefer-const': ['warn', { destructuring: 'all' }],
  eqeqeq: ['error', 'smart'],
  'no-empty': ['error', { allowEmptyCatch: false }],
  // Backend + modern frontend already run clean under this; underscore-prefixed
  // args/vars are the project's established "intentionally unused" convention
  // (e.g. `catch (_) {}` sites, callback signatures that must match an API).
  'no-unused-vars': ['error', {
    args: 'none',
    varsIgnorePattern: '^_',
    argsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
  }],
};

export default [
  {
    ignores: [
      'node_modules/**',
      'public/vendor/**',
      'public/*.min.js',
      'test-results/**',
      'python/**',
      '**/*.backup-*.json',
      'diag-*.mjs',
    ],
  },
  {
    // Backend: ESM, Node.js runtime.
    files: ['**/*.js'],
    ignores: ['public/**', 'test/**', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: baseRules,
  },
  {
    // Backend tests: same rules, + node:test globals.
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: baseRules,
  },
  {
    // Frontend: classic <script> (no import/export), browser runtime. Chart/L/
    // SwaggerUIBundle come from separately-loaded vendor <script> tags
    // (chart.min.js, vendor/leaflet/leaflet.js, the unpkg swagger-ui bundle) —
    // real globals at runtime, just not visible to a per-file linter.
    files: ['public/**/*.js'],
    ignores: ['public/vendor/**', 'public/*.min.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        DVhubCommon: 'readonly',
        Chart: 'readonly',
        L: 'readonly',
        SwaggerUIBundle: 'readonly',
      },
    },
    rules: baseRules,
  },
  {
    // family.html loads this one frontend file as `<script type="module">`
    // (uses export {}), unlike every other classic-script public/*.js file.
    files: ['public/family-screensaver-logic.js'],
    languageOptions: { sourceType: 'module' },
  },
  {
    // Legacy classic-script files: no-var frozen off (see header comment).
    files: LEGACY_VAR_FILES,
    rules: { 'no-var': 'off' },
  },
  {
    // settings.js and tools.js are both loaded on settings.html and share the
    // window scope by design (see .planning/QUALITY-REVIEW-2026-07-01.md item 5
    // — the tools.js/settings.js double-wiring is tracked for consolidation).
    // Until that lands, these tools.js-defined functions are real globals from
    // settings.js's point of view, not undefined references.
    files: ['public/settings.js'],
    languageOptions: { globals: { checkForUpdate: 'readonly', initEosTab: 'readonly' } },
  },
  {
    // Pre-existing `eslint-disable-next-line no-console` comments predate this
    // config (no-console isn't enabled — server.js/routes-api.js console.* at
    // boot/infra level is the project's deliberate two-channel logging design,
    // see .planning/QUALITY-REVIEW-2026-07-01.md §5). Flagging those old
    // disable-comments as "unused directive" would be pure noise unrelated to
    // this rollout; only complain about directives targeting rules we run.
    files: ['**/*.js'],
    linterOptions: { reportUnusedDisableDirectives: false },
  },
];
