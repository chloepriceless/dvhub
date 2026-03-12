# DVhub Minimum-SOC Inline Control Design

**Context:** The dashboard currently shows `Minimum-SOC` as a read-only metric in `ANLAGE > ZUSATZWERTE`, while manual writes happen separately in the lower control area. That split makes the feature hard to discover, duplicates one control concept in two places, and forces the user away from the place where the current value is already visible.

**Scope:** Move the manual `Minimum-SOC` write interaction to the top metric row in the dashboard. Replace the lower write control with a single primary entry point that supports readback, manual adjustment, explicit submit, and visible pending confirmation until the updated readback arrives.

**Goals**

- Make `Minimum-SOC` editable from the existing metric row in `ANLAGE > ZUSATZWERTE`.
- Remove the duplicated lower `Minimum-SOC (%)` write block.
- Use a compact popup editor with slider and explicit `Absenden`.
- Close the popup immediately after submit.
- Keep the displayed value readback-driven, not optimistic.
- Show a subtle pending state after submit until a changed readback value is detected.
- Preserve the existing backend write path for `minSocPct`.

**Non-Goals**

- No second input mode such as free-text percent entry.
- No new backend API endpoint.
- No background timeout or retry workflow in v1.
- No broader redesign of the dashboard metrics beyond the `Minimum-SOC` interaction.

**Problem Summary**

- Users currently see `Minimum-SOC` where they expect interaction, but cannot change it there.
- The actual write control sits lower in the UI and is easy to miss.
- A slider without explicit submit would be risky on mobile because drag gestures can trigger accidental writes.
- The UI needs to communicate that a submitted value is not yet confirmed until the system reports it back.

**Chosen Approach**

- Turn the `Minimum-SOC` metric row into the only write entry point.
- Keep the row readback-first, but visually emphasize that it is interactive.
- Open a compact popup editor anchored to the metric on larger screens.
- Allow the same editor to render as a compact bottom sheet on smaller screens.
- Submit via explicit `Absenden`, then close immediately.
- Start a subtle blinking pending state on the metric value until updated readback arrives.

**Rejected Alternatives**

- Full modal dialog:
  - More robust on mobile, but too heavy for a single-value adjustment.
- Inline expansion inside the metric list:
  - Simpler structure, but makes the metrics block unstable and visually noisy.
- Slider with immediate write on release:
  - Faster interaction, but too error-prone on touch devices.

**Target Behavior**

- The `Minimum-SOC` row remains visible in `ANLAGE > ZUSATZWERTE`.
- The row gets a clear affordance that it can be adjusted.
- Clicking or tapping the row opens the editor.
- The editor shows:
  - current percentage preview
  - slider
  - `Absenden`
- `Absenden` sends the new `minSocPct` value through the existing control write flow.
- The editor closes immediately after submit.
- The metric value begins a subtle blink to indicate pending confirmation.
- Once a changed readback `minSocPct` is observed, the blinking stops.
- The displayed value remains the latest readback throughout.

**Data Flow**

- Dashboard polling continues to populate `vic.minSocPct` as the authoritative readback.
- Opening the editor seeds the slider from the latest readback value.
- Submitting the editor sends `POST /api/control/write` with `{ target: 'minSocPct', value }`.
- After a successful request dispatch, the frontend stores a local pending state containing:
  - submitted target value
  - previous readback value
  - submit timestamp
- The pending state controls the blinking UI treatment.
- On subsequent dashboard refreshes, the pending state is cleared when readback confirms a changed `minSocPct`.

**Readback Rules**

- The metric text always renders from backend readback, not from the slider state.
- Pending confirmation ends when the next readback shows a value different from the pre-submit readback.
- If the system was already at the submitted value, the UI may clear pending as soon as a fresh poll confirms that same target value.
- If the write request fails, pending is cleared immediately and the existing error message path remains the visible failure signal.

**UI Notes**

- The full metric row should be clickable, not just the number.
- The row should be slightly more prominent than read-only rows so the capability is discoverable.
- The blink effect should be restrained: pulse or soft brightness shift, not aggressive flashing.
- The popup should stay intentionally small and focused.
- The lower `Minimum-SOC (%)` manual write block is removed to avoid duplicate control surfaces.

**Technical Approach**

- Update `public/index.html` to make the top `Minimum-SOC` metric interactive and to remove the lower `Minimum-SOC (%)` input/button block.
- Extend `public/app.js` with:
  - popup open/close state
  - slider state seeded from readback
  - submit handler reusing the existing `minSocPct` write endpoint
  - pending write state keyed to `Minimum-SOC`
  - readback reconciliation logic that stops blinking on confirmation
- Reuse the existing control status area and error handling patterns rather than introducing a separate notification system.

**Testing Impact**

- Dashboard render test for interactive `Minimum-SOC` row.
- Interaction test for opening the popup and closing it after `Absenden`.
- Control write test ensuring `minSocPct` is still written via the existing endpoint.
- Pending-state test ensuring the metric blinks after submit.
- Readback test ensuring blinking stops when changed readback arrives.
- Failure test ensuring pending state does not stick after write failure.
- Cleanup test ensuring the old lower `Minimum-SOC` write block is removed.

**Acceptance Criteria**

- `Minimum-SOC` is adjusted from the top metric row, not from a lower duplicate control.
- The editor uses a slider plus explicit `Absenden`.
- The editor closes immediately after submit.
- The displayed metric value continues to come from readback.
- After submit, the metric shows a subtle pending blink until readback confirms the update.
- Existing backend write behavior for `minSocPct` remains intact.
