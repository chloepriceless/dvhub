# DVhub System Discovery Design

**Context:** `setup.html` and `settings.html` currently require a manual value in `victron.host`. For first commissioning this is workable, but it is slower and more error-prone than necessary because Venus OS devices already advertise themselves in the local network. DVhub should keep the manual host field, but add a guided way to discover a matching system server-side and copy the selected IP into the existing field.

**Scope:** Add a manufacturer-aware discovery workflow to DVhub that starts on demand from the UI, runs server-side in the same local network as the target system, and currently supports only `victron`. Keep the architecture generic enough that later manufacturers can plug into the same flow without rebuilding setup or settings.

**Goals**

- Keep manual entry of `victron.host` fully supported.
- Add a `Find System IP` action next to the host field in setup and settings.
- Run discovery on the DVhub server, not in the browser.
- Make the backend discovery API generic by manufacturer.
- Start with one provider: `victron`.
- Return normalized, deduplicated discovery results that the UI can present directly.
- Keep discovery additive: no autosave, no background scan, no schema migration.

**Audience**

- Primary: installers and operators during first setup or later reconfiguration.
- Secondary: future manufacturer integrations that need the same discovery flow.
- Non-goal: automatic full device onboarding or persistent network inventory.

**Problem Summary**

- The existing setup transport step blocks on `victron.host`, but offers no help finding the right address.
- The settings workspace exposes the same field with the same limitation.
- Users often know the manufacturer, but not the current IP.
- The current UI is specific to one field, but the product direction already points toward manufacturer-specific behavior.

**Design Principles**

- Discovery is a helper, not a required path.
- The server owns all network probing.
- UI stays generic and driven by field metadata where possible.
- Manufacturer-specific logic belongs in backend providers, not in duplicated frontend branches.
- The first version stays small: one provider, one endpoint, one result picker pattern.

**Target Behavior**

- `settings.html` and `setup.html` keep the editable host field.
- When the field supports discovery, the UI shows a secondary action next to it.
- The UI reads the current manufacturer and requests discovery only for that manufacturer.
- The API returns a normalized list of candidate systems with human-readable labels and usable host/IP data.
- The user chooses one result and DVhub copies the IP into the current draft field.
- Saving remains explicit and unchanged.

**Architecture**

- Add a backend module such as `dvhub/system-discovery.js`.
- Expose one generic function:
  - `discoverSystems({ manufacturer, timeoutMs })`
- Internally use a provider registry:
  - `victron -> discoverVictronSystems()`
- The first implementation uses an app-integrated Node-based mDNS discovery path, not external host tools.
- Add one API endpoint:
  - `GET /api/discovery/systems?manufacturer=victron`
- The endpoint validates the requested manufacturer, calls the registry, and returns normalized results.
- Add lightweight field metadata in `config-model.js` so the host field can declare that discovery is available and tied to the selected manufacturer path.

**Data Flow**

- User clicks `Find System IP` in setup or settings.
- Frontend reads the active manufacturer from the current draft/effective config.
- Frontend requests `/api/discovery/systems?manufacturer=<value>`.
- Backend resolves the matching provider and runs a short discovery.
- Provider returns raw results, then the module normalizes and deduplicates them.
- Frontend renders one of four states:
  - loading
  - results available
  - no systems found
  - discovery unavailable/error
- User selects one result and the UI writes its IP into `victron.host`.

**Response Shape**

```json
{
  "ok": true,
  "manufacturer": "victron",
  "systems": [
    {
      "id": "victron-venus-gx-192.168.1.20",
      "label": "Venus GX",
      "host": "venus-gx.local",
      "ip": "192.168.1.20",
      "meta": {
        "serviceName": "Venus GX"
      }
    }
  ],
  "meta": {
    "durationMs": 1800,
    "cached": false
  }
}
```

**Error Handling**

- Unsupported manufacturer:
  - return a clear API error that discovery is not yet available for that manufacturer
- Discovery timeout or no results:
  - return `ok: true` with an empty `systems` array
- Invalid or incomplete raw mDNS records:
  - drop them during normalization instead of exposing partial garbage to the UI
- Provider/runtime failure:
  - return an explicit error message while keeping manual host entry fully usable

**UI Behavior**

- The discovery button is visible only for fields marked as discovery-capable.
- The button is disabled while a request is active.
- A compact picker area shows result rows with label, host, and IP.
- Empty-state copy tells the user that manual entry is still available.
- Error-state copy explains the failure without blocking the form.
- Setup and settings use the same interaction model and wording.

**Technical Approach**

- Extend `config-model.js` field metadata for `victron.host` with discovery hints instead of hardcoding the UI only by path.
- Keep the frontend rendering logic generic enough that additional discovery-capable host fields can reuse it later.
- Add a small pure-JS mDNS dependency to `package.json` and isolate its use inside `system-discovery.js`.
- Keep `server.js` thin: validate request, call the module, return JSON.
- Do not add caching in v1.
- Do not add passive discovery, polling, or background inventory.

**Testing Impact**

- New backend tests for manufacturer dispatch, normalization, deduplication, timeout handling, and unsupported manufacturers.
- Setup tests for button visibility, request flow, result selection, and non-blocking error states.
- Settings tests for the same host-field workflow in the full configuration shell.
- No live network tests in CI; use deterministic stubs/fakes for discovery responses.

**Risks**

- mDNS payloads can vary across devices and networks; normalization must be conservative.
- If frontend logic is duplicated between setup and settings, the two flows will drift.
- If the API returns hostnames without usable IPs, users still need manual correction, which weakens trust in the helper.

**Acceptance Criteria**

- `setup.html` and `settings.html` both offer a discovery action next to the existing host field.
- Discovery runs server-side and is filtered by the selected manufacturer.
- The first release supports `victron` only.
- A selected discovery result fills `victron.host` without auto-saving.
- If discovery fails or finds nothing, manual entry remains fully available.
- The backend architecture can add future manufacturer providers without changing the API shape or rebuilding the UI flow.
