# DVhub Settings Navigation Design

**Context:** DVhub currently splits setup, settings, and tools into parallel entry points. The settings page exposes too many equally weighted areas, keeps technical sections visible in the main navigation, and spends too much vertical space on header cards before users can edit the values they came for.

**Scope:** Redesign the navigation and information architecture for `setup.html`, `settings.html`, and `tools.html`, simplify the settings shell into a compact admin-first flow, and keep advanced register-oriented options available without letting them dominate the default experience.

**Goals**

- Reduce the primary app navigation to a small set of clear destinations.
- Make the settings flow understandable for plant operators who are not professional admins.
- Keep advanced diagnosis and register-level tools available, but move them out of the default path.
- Replace the current wide, card-heavy header area with a tighter layout that gives more space to the active form.
- Keep the implementation compatible with the existing config model and settings shell tests.

**Audience**

- Primary: admins, installers, and operators during setup or maintenance.
- Secondary: non-technical plant operators who only occasionally change values.
- Non-goal: optimize the settings UI for daily operation. The daily workflow stays centered on the dashboard.

**Design Principles**

- Prefer task language over technical taxonomy.
- Show few top-level destinations and one active workspace at a time.
- Use progressive disclosure for rare or risky options.
- Keep operational actions close to the content they affect.
- Reserve warning styling for risky expert areas instead of making the whole page feel technical.

**Primary Navigation**

- `Leitstand`
- `Einrichtung`
- `Wartung`

`Tools` stops being a primary entry point. Its functions move into the maintenance experience.

**Target Information Architecture**

`Einrichtung`

- `Schnellstart`
- `Anlage verbinden`
- `Steuerung`
- `Preise & Daten`
- `Erweitert`

`Wartung`

- `Systemstatus`
- `Import & Export`
- `Historie`
- `Diagnose`

**Section Mapping**

- Current `system` moves under `Einrichtung > Anlage verbinden` or `Einrichtung > Schnellstart` depending on whether the item is action-oriented or configuration-oriented.
- Current `victron` and `meter` stay together under `Einrichtung > Anlage verbinden`.
- Current `controlWrite`, `dvControl`, and `schedule` move under `Einrichtung > Steuerung`.
- Current `pricing`, `epex`, `influx`, and `telemetry` move under `Einrichtung > Preise & Daten`.
- Current `points`, `scan`, and other register-level controls move under `Einrichtung > Erweitert` or `Wartung > Diagnose`.
- Current health, restart, import, export, and history-import actions move out of the settings header and into `Wartung`.

**Page Behavior**

- `setup.html` becomes the guided entry into `Einrichtung`.
- `settings.html` becomes the main compact configuration workspace for `Einrichtung`.
- `tools.html` becomes `Wartung` in structure and wording, even if the file path stays unchanged for compatibility.
- The settings shell opens on `Schnellstart` instead of a generic overview.
- The active workspace shows one destination at a time with a short intro and compact groups.

**Layout**

- Keep the existing global shell, but update the app navigation labels and active states.
- Replace the current three-card settings header with one compact control bar:
  - title
  - short supporting text
  - `Speichern`
  - `Neu laden`
  - optional secondary actions
- Keep a left sidebar for section navigation, but shorten labels and remove long descriptive blurbs.
- Keep the right content area as one strong panel with grouped form sections.
- Use collapsible groups for secondary and expert settings.
- Move maintenance actions into dedicated panels on the maintenance page instead of sticky cards above the form.

**Content Rules**

- Rename technical or vague labels to task-oriented labels.
- Use helper text only where it changes the decision.
- Keep section intros to one short paragraph.
- Keep the sidebar secondary line status-oriented, not explanatory.
- Label expert zones clearly, for example with `Nur bei Sonderfällen ändern`.

**Accessibility and Usability**

- Preserve keyboard-accessible sidebar navigation and `details/summary` groups.
- Keep visible focus states and adequate touch targets.
- Preserve responsive collapse to one column on narrow widths.
- Ensure destructive actions such as service restart remain clearly separated.

**References**

- Apple Human Interface Guidelines: hierarchical navigation and clear visual hierarchy for preferences and settings. [HIG](https://developer.apple.com/design/human-interface-guidelines/)
- Apple UI design tips: keep interfaces focused and place controls near the content they affect. [UI Design Dos and Don’ts](https://developer.apple.com/design/tips/)
- Material Design guidance for settings, navigation, and progressive disclosure. [Settings](https://m1.material.io/patterns/settings.html), [Navigation](https://m1.material.io/patterns/navigation.html), [Expansion Panels](https://m1.material.io/components/expansion-panels.html)

**Testing Impact**

- Update branding and shell tests for the renamed navigation labels and maintenance positioning.
- Update settings shell tests for the new destination labels and destination count.
- Add markup assertions for the compact header and the moved maintenance actions.

