# Roadmap: DVhub

## Milestones

- ✅ **v1.0 Server.js Monolith Decomposition** -- Phases 1-5 (shipped 2026-03-27)
- 🚧 **v0.4.2 Security & Stability Hardening** -- Phases 6-7 (in progress)

## Phases

<details>
<summary>v1.0 Server.js Monolith Decomposition (Phases 1-5) -- SHIPPED 2026-03-27</summary>

- [x] Phase 1: Foundation and Leaf Module (2/2 plans) -- completed 2026-03-26
- [x] Phase 2: I/O Modules (2/2 plans) -- completed 2026-03-26
- [x] Phase 3: Polling (2/2 plans) -- completed 2026-03-27
- [x] Phase 4: Automation Core (2/2 plans) -- completed 2026-03-27
- [x] Phase 5: HTTP Layer and Orchestrator Cleanup (3/3 plans) -- completed 2026-03-27

Full details: `.planning/milestones/v1.0-ROADMAP.md`

</details>

### v0.4.2 Security & Stability Hardening

- [ ] **Phase 6: Server-Side Security Hardening** - Git rollback, auth-bypass restriction, SQL injection prevention
- [ ] **Phase 7: Frontend Security & Monitoring Fix** - XSS prevention across frontend files and heartbeat SOC correction

## Phase Details

### Phase 6: Server-Side Security Hardening
**Goal**: Server-side endpoints are protected against update rollback failures, unauthorized LAN access to dangerous operations, and SQL injection
**Depends on**: Nothing (independent of previous milestone)
**Requirements**: SEC-01, SEC-02, SEC-04
**Success Criteria** (what must be TRUE):
  1. When git-based update triggers npm install and it fails, the server automatically rolls back to the previously saved git revision and the system remains in a working state
  2. LAN clients without auth tokens can only access read-only API endpoints -- attempts to hit hardware control, update, restart, or admin endpoints from LAN without a token return 401
  3. All PostgreSQL queries in telemetry-store-pg.js use parameterized queries or assertSqlIdentifier-validated identifiers -- no raw template literal interpolation of user-controllable values reaches the database
**Plans**: 2 plans

Plans:
- [ ] 06-01-PLAN.md -- SQL identifier validation + LAN auth allowlist (SEC-04, SEC-02)
- [ ] 06-02-PLAN.md -- Git update rollback hardening (SEC-01)

### Phase 7: Frontend Security & Monitoring Fix
**Goal**: Frontend code is XSS-safe and monitoring heartbeat reports correct battery SOC
**Depends on**: Nothing (independent of Phase 6)
**Requirements**: SEC-03, BUG-01
**Success Criteria** (what must be TRUE):
  1. All dynamic content injection in history.js, app.js, tools.js, settings.js, setup.js, and explorer.js uses textContent or DOM API methods -- zero innerHTML assignments with dynamic or user-controllable data remain
  2. Monitoring heartbeat payload includes the correct SOC value read from state.victron.soc (not state.battery?.soc or any other incorrect path)
**Plans**: TBD

Plans:
- [ ] 07-01: TBD
- [ ] 07-02: TBD

## Progress

**Execution Order:**
Phases 6 and 7 are independent and can execute in any order.

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1-5 | v1.0 | 11/11 | Complete | 2026-03-27 |
| 6. Server-Side Security | 1/2 | In Progress|  | - |
| 7. Frontend Security & Monitoring | v0.4.2 | 0/2 | Not started | - |
