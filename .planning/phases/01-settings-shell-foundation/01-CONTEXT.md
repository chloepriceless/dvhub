# Phase 1: Settings Shell Foundation - Context

**Gathered:** 2026-03-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 1 delivers the new structural shell for the Settings experience: a compact left-sidebar navigation, a focused right-hand work area, clearer task-oriented labels, and a denser overall layout. This phase does not yet redesign the setup wizard, formalize advanced/expert disclosure behavior, or implement save/restart/recovery UX.

</domain>

<decisions>
## Implementation Decisions

### Sidebar Structure
- The Settings page should use a fixed left sidebar rather than one long scrolling document.
- The sidebar should be reduced to roughly 5-6 main navigation points, not the current 10 technical sections.
- Main navigation labels should be task-oriented and beginner-friendly, not only internal technical labels.
- Register-heavy and low-level technical areas should not sit in the main core flow; they should be grouped under a later/lower "Erweitert" area.
- Status, save actions, and Health/Service should remain in a compact top header area rather than becoming normal sidebar content.

### Section Workspace Behavior
- Opening Settings should first show a short overview/start area rather than dropping the user straight into the first section.
- Clicking a sidebar item should swap the right-hand workspace directly in an app-like way, not behave like a long document with jump links.
- Each opened section should start with a short orientation header, then move quickly into the relevant settings fields.
- The shell may remember the last opened area for convenience, but should still start from the overview as the default entry state.

### Density And Layout
- The new layout should be more compact than today, but still calm and beginner-readable.
- Desktop sections should use a two-column field layout where it improves scan speed; mobile can remain single-column.
- Short helper text should remain visible directly on the page rather than being hidden behind icons by default.
- Both the sidebar and the save/action bar may stay sticky while the user scrolls.

### Claude's Discretion
- Exact visual styling of the sidebar, overview cards, and active-state treatment.
- Exact breakpoint rules for when two-column layouts collapse to one column.
- Whether the overview uses a simple list, compact cards, or another light-weight summary pattern.
- Whether Dashboard, Tools, and Setup links stay in the current header placement or get a modest structural refinement within this phase, as long as the main Phase 1 decisions above stay intact.

</decisions>

<specifics>
## Specific Ideas

- The user explicitly referenced a Vivaldi-like left-tab feeling for the main navigation.
- The desired result is "kompakter, aber uebersichtlicher" rather than a hyper-dense expert console.
- The user wants beginners to find the right area faster instead of scanning the entire Settings page.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `dv-control-webapp/config-model.js`: already defines `SECTIONS` and drives `getConfigDefinition()`, which is the strongest existing source for sidebar structure and renamed section labels.
- `dv-control-webapp/public/settings.js`: already has `renderDefinition()`, `groupFields()`, and `renderField()`, which can be refactored into a section-focused renderer instead of a full-page dump.
- `dv-control-webapp/public/settings.html`: already contains a hero/header area, action buttons, Health/Service block, and the `#settingsSections` mount point that can evolve into the new shell.

### Established Patterns
- Settings are schema-driven from backend metadata, not hand-written field markup. Phase 1 should preserve that pattern.
- Frontend behavior is plain imperative DOM manipulation in vanilla JavaScript; there is no framework/router to lean on.
- The page currently renders every section sequentially and opens every group by default, which is exactly the behavior Phase 1 needs to break structurally.

### Integration Points
- Sidebar labels and section grouping will connect most directly to the section metadata in `dv-control-webapp/config-model.js`.
- Active-section state and right-hand workspace swapping will land in `dv-control-webapp/public/settings.js`.
- Sticky save/status behavior will likely extend the existing top action area in `dv-control-webapp/public/settings.html` rather than invent a second save surface.

</code_context>

<deferred>
## Deferred Ideas

- Guided first-run setup redesign - belongs to Phase 2.
- Formal expert/advanced disclosure model and inherited/default summaries - belongs to Phase 3.
- Restart/reconnect/risky-save communication - belongs to Phase 4.
- Broader diagnostics and expert escape paths - belongs to Phase 5.

</deferred>

---
*Phase: 01-settings-shell-foundation*
*Context gathered: 2026-03-08*
