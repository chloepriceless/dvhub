# DVhub Folder Rename Design

**Date:** 2026-03-09
**Branch:** `codex/history-analytics`

## Goal

Rename the executable app folder from `dv-control-webapp` to `dvhub` so the repository, runtime, installer, and documentation consistently use DVhub naming. Existing hosts must migrate in place without losing local config or telemetry data.

## Current State

- Repository checkout lives at `/opt/dvhub`
- Executable app currently lives at `/opt/dvhub/dv-control-webapp`
- Config lives at `/etc/dvhub`
- Runtime data lives at `/var/lib/dvhub`
- Branding and service naming already use `dvhub`
- Many repo references still point to `dv-control-webapp`

## Chosen Approach

Use an in-place rename with installer-driven migration.

- Rename the repo app directory from `dv-control-webapp` to `dvhub`
- Update all code, tests, installer paths, service paths, and docs to the new directory
- Extend the installer to detect legacy hosts and migrate them automatically
- Remove the old app directory after successful migration
- Restart `dvhub.service` at the end of the installer so the web UI reflects the new version immediately

This avoids keeping any legacy compatibility path around and leaves hosts in one clean structure.

## Target Structure

Local repo and deployed host should converge on this layout:

- `/opt/dvhub` = checked-out repository
- `/opt/dvhub/dvhub` = executable Node app
- `/etc/dvhub` = configuration
- `/var/lib/dvhub` = telemetry database and runtime data

## Installer Migration Rules

The installer must detect whether the host is still on the old layout:

- Legacy app path: `/opt/dvhub/dv-control-webapp`
- New app path: `/opt/dvhub/dvhub`

Migration behavior:

1. Inspect the legacy app folder before updating the repo.
2. Move only host-local artifacts that are not repo-managed:
   - local config files such as `config*.json` into `/etc/dvhub`
   - data directories, `*.sqlite`, `*.db`, and other runtime state into `/var/lib/dvhub`
3. Do not preserve legacy app code from the old folder; code continues to come from the repo checkout.
4. After the repo is updated, use only `/opt/dvhub/dvhub` as the application directory.
5. Remove `/opt/dvhub/dv-control-webapp` once migration succeeds.
6. If the installer cannot classify the layout safely, stop with a clear error instead of guessing.

## Code Impact

The rename affects:

- `install.sh`
- `README.md`
- app-local tests and scripts
- repo-root tests that assert installation paths
- any references to working directories, `npm` commands, and `server.js` locations

The implementation should prefer path constants in the installer so the old and new structures are easy to reason about and test.

## Verification

Required verification after implementation:

- Full app test suite from the renamed app directory
- Root installer and README tests
- Smoke start of the app using the new folder path
- Manual confirmation that `history.html` and the history API still load
- Manual inspection that installer migration preserves local config/data paths and removes the old folder

## Non-Goals

- No compatibility symlink for `dv-control-webapp`
- No change to `/etc/dvhub` as the config location
- No change to `/var/lib/dvhub` as the data location
- No repo-root flattening of the app into `/opt/dvhub`
