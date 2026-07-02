# Phase 25: Docs + new:endpoint scaffold + flag-default flip

This is the final phase of the API Pipeline re-architecture. It ships the on-ramp (docs plus a
`new:endpoint` scaffold) and the rollout switch (flip the dispatch-flag default to the new
pipeline), while RETAINING the old ladder behind the flag for one more release. It does not
migrate any endpoint, touch persistence, or change the wire protocol, so it stays comfortably
under the 40% context bound: the surface is a handful of docs, one generator script plus its
golden test, and a one-field default change with a small dispatch test. The canonical locked
decisions live in `scratchpad/canonical.md`; do not contradict them.

Paste the block below into a fresh Claude Code session. It is self-contained: you do not need to
read this table of contents first.

### Starter Prompt

````text
This is Phase 25 of the API Pipeline re-architecture: Docs + new:endpoint scaffold + flag-default flip.
Model: Opus 4.8, xhigh effort. Harness: Claude Code.
ULTRACODE: this phase is NOT batch-heavy (a small docs set, one scaffold generator plus its
golden test, and a one-field default flip). Hand-spawn 2 to 3 parallel agents. Reach for
`ultracode` only if you choose to run the docs sweep as a Workflow fan-out across the four doc
targets; the default is hand-spawned agents.
Goal: make the new request pipeline the production default and give contributors a documented,
scaffolded on-ramp for adding an endpoint, while keeping the old ladder reachable behind the
flag and naming the exit criteria for its deletion next release.

STEP 0 - PRE-FLIGHT
- Run `git status`. The worktree is SHARED with concurrent sessions; if it is dirty with files
  you did not create, STOP and ask before staging anything. Commit only with EXPLICIT paths,
  never `git add -A`.
- Scan Claude Code memory (the user MEMORY index) for entries in this phase's domain. Suggested
  concrete topics to read: "Server API pipeline audit (2026-06-29)" (the locked SPEC), the
  "AI-architecture overhaul" entries (do NOT re-bloat AGENTS.md or GEMINI.md when editing root
  CLAUDE.md; keep them thin pointers), "Biome on touched files" (changed-files-only rule), and
  "Instruction-files policy" (CLAUDE.md is canonical and Opus-4.8-targeted with a Sonnet
  baseline). Summarize what each implies for this phase before writing.

STEP 1 - LOAD CONTEXT (do NOT read planning docs directly; spawn ONE Explore agent)
Have the Explore agent read and summarize, anchored on SYMBOL NAMES and route strings (never line
numbers; main.ts is ~1695 lines):
- docs/api-pipeline/state.md and docs/api-pipeline/progress.md (the running ledger: which phases
  landed, the accumulated knownDeviation list, the deferred-items list).
- docs/api-pipeline/phase-25-docs-flag-flip.md (this file).
- server/main.ts: the `createServer` prefix dispatcher and the branch that puts the new router in
  front of the old `handleApi` with the per-path catch-all delegate (anchor on the dispatch
  decision and `handleApi`, not a line). Report the EXACT env-var name and the config field that
  gate the new pipeline, and the flag's CURRENT default.
- server/http/config.ts: the pure `loadConfig(env)` from Phase 24 and the dispatch-flag field it
  exposes (this is where the default most likely lives). Do not invent a second flag name.
- server/http/registry.ts and server/http/index.ts (the barrel): how a domain `routes: RouteDef[]`
  table is spread into the lookup, so the scaffold registers a new module the same way.
- server/http/error_codes.ts: the append-only `as const` `(domain, reason)` catalog shape, so the
  scaffold appends a paired code correctly (AIP-193 append-only).
- One early migrated domain module to copy from, e.g. server/leaderboard.ts (and server/characters.ts
  for a `requireOwned*` :id example): the canonical `RouteDef` + thin-handler + typed-schema shape.
- server/CLAUDE.md and CLAUDE.md (root): the existing "adding an endpoint" guidance and repo map,
  so the docs edits extend rather than duplicate.
- The Phase 2 test harness under tests/server/ (the injected-FakeDb recipe and `fakeCtx`), so the
  scaffold's emitted test copies the FakeDb idiom, not the old `sql.includes()` pg-mock.
- src/ui/i18n.catalog/ (the `apiError.*` domain from Phase 22) and `userFacingApiError` in
  src/main.ts: where the scaffold's emitted English catalog entry and code must land for a real
  endpoint, and the localize-by-code rule.
The Explore agent must RETURN: (1) the exact dispatch-flag env-var name, config field, and current
default; (2) the dispatch-branch structure (new router in front, per-path catch-all to old
`handleApi`); (3) the canonical RouteDef + thin-handler + schema shape with a real module path to
template from; (4) the error_codes.ts append-only structure and how a code maps to `apiError.*`;
(5) the FakeDb test recipe filename and shape; (6) where the current add-an-endpoint prose lives in
server/CLAUDE.md; (7) the accumulated knownDeviation list and the deferred-items list from state.md
(needed for the exit criteria and teardown handoff).

STEP 2 - CHOOSE ORCHESTRATION + EXECUTE
Hand-spawn parallel agents, each owning a complete vertical slice (behavior plus its tests), and
give each ONLY the Explore summary (not the raw files):
- Agent A (docs sweep, no test, owns a cross-reference check):
  - server/CLAUDE.md: document the pipeline model (one importable spine under server/http/,
    per-domain `routes: RouteDef[]`, thin req/res-free handlers, the per-path catch-all delegate
    in front of the old ladder), a graduated "adding an endpoint" recipe (public read, then
    authenticated, then owner-gated :id), the error-localization rule (server emits a stable CODE,
    client localizes via `userFacingApiError` and `apiError.*`, never English in the server), and
    the injected-FakeDb test recipe REPLACING the old pg-mock `sql.includes()` idiom.
  - CLAUDE.md (root): add the server/http/ spine to the repo map and the architecture notes as the
    server request seam. Keep it tight; do not re-bloat AGENTS.md or GEMINI.md.
  - server/http/CLAUDE.md (NEW): the local conventions for the spine modules
    (router, compose, context, schema, errors, error_codes, registry, index, middleware/*, config),
    the RouteDef metadata contract, and the per-surface envelope rule.
  - i18n docs (the apiError.* catalog domain and the client-localize-by-code rule, in the existing
    i18n workflow doc).
- Agent B (the `new:endpoint` scaffold, owns its golden test):
  - A generator (e.g. scripts/new_endpoint.mjs) plus an `npm run new:endpoint` package.json script
    that emits, from a single endpoint descriptor: a `RouteDef` stub in a domain module, a typed
    schema (Standard-Schema-shaped, `Infer`-derived handler input), a paired error code APPENDED to
    error_codes.ts, an English `apiError.*` catalog entry, and a paired FakeDb-based copy-from TEST
    file. It AUTO-ATTACHES a `requireOwned*` loader on any `:id` route.
  - A golden test (tests/server/new_endpoint.test.ts) that runs the scaffold into a temp dir,
    asserts the output type-checks and its emitted test passes, and asserts the append to
    error_codes.ts is append-only (no existing code reordered or removed).
- Agent C (the flag-default flip + exit criteria, owns the dispatch-default test):
  - Flip the dispatch-flag DEFAULT (the config field from Phase 24) so the new pipeline is the
    production default; keep the old ladders reachable when the flag is set back to the old value.
    Do NOT change the per-path catch-all delegate semantics; only the default changes. The flip
    covers ALL FOUR flag-gated entries (`setApiDispatchMode` recomputes apiEntry, adminApiEntry,
    oauthApiEntry, and internalApiEntry, whose delegate is the composite that tries
    handleDailyRewardInternalApi first), not just the /api handleApi entry.
  - A test (tests/server/http/dispatch_default.test.ts) asserting BOTH: default config routes a
    migrated path through the new pipeline on each of the four entries, and the old value still
    reaches each legacy delegate (handleApi, handleAdminApi, handleOAuth, the internal composite).
  - Designate one early migration commit (by hash and the domain module it added, e.g. the first
    authenticated endpoint) as the canonical "add one authenticated endpoint" example, and
    reference it from Agent A's recipe.
  - Write the old-ladder deletion EXIT CRITERIA into docs/api-pipeline/state.md (and link from
    server/http/CLAUDE.md): a concrete metric gate (for example zero requests on the old-path
    metric label for N days and zero unexplained 404 delta), a threshold, and a named owner,
    tracked as a next-release follow-up PR. The old ladder is RETAINED this phase. The criteria
    MUST carve out the deliberately delegate-served shapes, which legitimately keep the old-path
    label warm under flag 'new' (the oauthInternalOffTable405 set, HEAD-to-GET delegation, and
    any 18b off-table remainder); a naive zero-requests gate is unreachable otherwise. Also name
    the expiry of the Phase 18/18b dual-edit MAINTENANCE RULE (ladder branch + RouteDef twin) as
    part of the deletion follow-up.
There is no documented a/b split for this phase. It is low context; do not split.

INVARIANTS THIS PHASE MUST KEEP
- The single dispatch-flag plus per-path catch-all delegate model is LOCKED: flipping the default
  must not change how un-migrated paths fall through to the old ladder, and must not collapse the
  flag into a different coexistence model.
- Server authority and the stable-code i18n boundary: any code the scaffold emits is a stable CODE
  re-localized client-side via `userFacingApiError` plus an `apiError.*` English entry, NEVER
  English text in the server.
- error_codes.ts stays APPEND-ONLY (AIP-193): the scaffold appends, never reorders or removes.
- No magic values: the flag name, the exit-criteria thresholds, and any scaffold defaults are named
  constants or named in docs, not bare literals duplicated across files.
- Module-first: NEVER grow main.ts. The scaffold emits a new (or extends an existing) domain
  `routes: RouteDef[]` module registered through the registry barrel, not an inline route in
  main.ts.
- This phase is server, docs, and tooling only: it must NOT touch src/sim/ (determinism and
  sim-purity are not at risk and must stay that way), and must NOT change the WS wire protocol.
- No persistence change this phase (no DDL, no JSONB shape change).
- No em dashes, en dashes, or emojis anywhere (code, comments, docs, commit text). Conventional
  Commits with a scope; EXPLICIT paths.

OUT OF SCOPE (do not do these here)
- DELETING the old ladder. This phase only NAMES the exit criteria; the deletion is a separate
  next-release PR.
- Migrating, adding, or changing any endpoint (all domains migrated in Phases 10 to 18 plus the
  Phase 18b late arrivals: github, desktop-login, daily-rewards). The scaffold emits a STUB only.
  PRECONDITION: Phase 18b MUST have landed before this phase runs; if any route family in server
  source still lacks either a RouteDef or a recorded permanent-delegate decision, STOP (see the
  stopping rules). The `oauthInternalOffTable405` deviation directs THIS phase to decide the off-table
  shapes it names at the deletion boundary (the GET /oauth/authorize + /oauth/device HTML pages:
  migrate onto `meta.envelope 'html'` RouteDefs or retain a delegate; the restart-countdown
  wrong-method 404-vs-405 shape), and phase-18b-late-arrivals.md hands THIS phase the analogous
  post-18b decisions it instructs 18b to record: the daily-rewards prefix-arm oddities (the
  ladder's auth-then-404 on wrong method / unknown subpath / the no-slash '/api/daily-rewardsX'
  shape) plus the ops family's family-wide pre-path 401.
- Changing the dispatch or coexistence model itself (locked in Phase 9), the metrics or logging
  (Phase 23), the config or timeouts or perf gate (Phase 24).
- The deferred API conventions A (versioning), D (ETag), F (Deprecation/Sunset), G (OpenAPI), and
  the separate full-CSP Report-Only effort and the concurrency-scalability workstream.

STEP 3 - VALIDATION + MULTI-AGENT REVIEW
Run, from repo root:
```
npx tsc --noEmit
npx vitest run tests/server/new_endpoint.test.ts tests/server/http/dispatch_default.test.ts
npm run ci:changed
```
Because flipping the default changes which path production serves, also run the Phase 9 dual-path
parity harness and the registry-completeness test to prove the default flip is parity-clean and no
route was dropped:
```
npx vitest run tests/server/http
```
If the scaffold or the canonical-example designation actually touches the real `apiError.*`
catalog or `userFacingApiError` in src/ (check `git diff --name-only`), also run:
```
npx vitest run tests/localization_fixes.test.ts
```
plus the per-surface code-parity test from Phase 22. If the diff only writes the scaffold output to
a temp dir inside its golden test, the S3 guard is not triggered by this diff; confirm that.
Then the full pre-merge gate (mirror CI):
```
npm test && npx tsc --noEmit && npm run build:env && npm run build:server && npm run build
```

Multi-agent review (spawn ONLY the agents whose surface this diff touches; check
`git diff --name-only` first):
- privacy-security-review: REQUIRED (server/ is touched, and this flips the PRODUCTION dispatch
  default). Have it confirm the old path stays reachable, the default flip exposes nothing the old
  path did not, the scaffold's emitted auth and `requireOwned*` stubs are safe-by-default, and no
  secret or internal text leaks in the new docs.
- cross-platform-sync: ONLY if the diff touches src/ (the `userFacingApiError` matcher or the
  `apiError.*` catalog). It usually will NOT, since the scaffold writes to a temp dir in its test;
  confirm via `git diff --name-only`.
- qa-checklist: at phase completion.
- Do NOT spawn migration-safety (no DDL or JSONB change) or architecture-reviewer (no src/sim/
  change).
Prompt each reviewer for COVERAGE, not filtering: report every correctness or requirement gap with
confidence and severity. Add this line to each: "If your review is truncated, resume from the last
file you fully reviewed and continue; do not restart from the top." Do not commit until each
reports no BLOCKING.

STEP 4 - COMMIT CADENCE (2 to 5 commits, Conventional Commits with a scope, EXPLICIT paths)
This phase ships as its own green, bisectable PR in the stacked chain.
- docs(http): document the api pipeline model and graduated add-an-endpoint recipe
  (paths: server/CLAUDE.md, server/http/CLAUDE.md, CLAUDE.md, docs/i18n-scaling/translation-workflow.md)
- feat(http): add `npm run new:endpoint` scaffold (RouteDef + schema + error code + catalog + FakeDb test)
  (paths: scripts/new_endpoint.mjs, package.json, tests/server/new_endpoint.test.ts)
- feat(server): flip the api dispatch flag default to the new pipeline
  (paths: server/http/config.ts, server/main.ts if needed, tests/server/http/dispatch_default.test.ts)
- docs(http): record the old-ladder deletion exit criteria and owner
  (paths: docs/api-pipeline/state.md, docs/api-pipeline/progress.md, server/http/CLAUDE.md)

STEP 5 - ACCEPTANCE CRITERIA (verifiable)
- [ ] server/CLAUDE.md documents the pipeline model, the graduated add-an-endpoint recipe, the
      stable-code error-localization rule, and the injected-FakeDb test recipe over the old pg-mock
      `sql.includes()` idiom.
- [ ] root CLAUDE.md repo map and architecture notes reference the server/http/ spine as the
      server request seam; AGENTS.md and GEMINI.md stay thin.
- [ ] server/http/CLAUDE.md exists and describes the spine modules and the RouteDef metadata and
      per-surface envelope contracts.
- [ ] i18n docs document the `apiError.*` catalog domain and the localize-by-code rule.
- [ ] `npm run new:endpoint` emits a RouteDef stub, a typed `Infer`-derived schema, a paired error
      code APPENDED to error_codes.ts, an English `apiError.*` entry, and a paired FakeDb-based
      test, auto-attaching `requireOwned*` on `:id` routes; the emitted output type-checks and its
      emitted test passes (golden test green).
- [ ] the dispatch-flag DEFAULT now routes a migrated path through the new pipeline on each of
      the FOUR flag-gated entries (api, admin, oauth, internal); the old value still reaches each
      legacy delegate (`handleApi`, `handleAdminApi`, `handleOAuth`, the internal composite); a
      test asserts both directions for all four.
- [ ] the per-path catch-all delegate behavior for un-migrated paths is unchanged (Phase 9 parity
      harness and registry-completeness test stay green).
- [ ] docs name the old-ladder deletion exit criteria (concrete metric gate, threshold, owner) as
      a next-release follow-up; the old ladder is RETAINED this phase.
- [ ] one early migration commit is designated (by hash and module path) the canonical add-one-
      authenticated-endpoint example, referenced from the recipe.
- [ ] full pre-merge gate green; no em dashes, en dashes, or emojis; Biome clean on changed files.

STEP 6 - DOC UPDATES + MEMORY
- Update docs/api-pipeline/progress.md: mark Phase 25 done and the migration packet COMPLETE; name
  the new artifacts (scripts/new_endpoint.mjs, the `new:endpoint` npm script, server/http/CLAUDE.md),
  the flipped flag (its exact name and new default), and the exit-criteria doc.
- Update docs/api-pipeline/state.md: record the dispatch default is now the new pipeline, the
  old-ladder deletion exit criteria and owner, and the full deferred-items list carried into the
  next release.
- Record in Claude Code memory: the dispatch-flag name and its flipped default, the exact wording
  of the old-ladder deletion exit criteria, the canonical-example commit hash, and any surprising
  rule discovered (for example the scaffold writing to a temp dir so it does not trip S3).

STEP 7 - FINAL RESPONSE FORMAT
Report: phase status (done or blocked); files touched (absolute paths); validation results (tsc,
the new tests, the parity harness, the full gate); review verdicts per agent; deferrals (the
old-ladder deletion follow-up PR and its exit criteria); a one-line handoff to "Phase 25 QA".

STOPPING RULES
- STOP if flipping the flag default would alter the per-path catch-all delegate semantics for
  un-migrated paths (only the default may change).
- STOP if any route family present in server source (sweep ALL of server/ for dispatched path
  literals, not just the four dispatcher files: the daily-rewards family hid behind a startsWith
  prefix in server/daily_rewards.ts once) lacks BOTH a RouteDef and a recorded permanent-delegate
  decision: that family would silently break at the next-release ladder deletion. Phase 18b is the
  precondition that clears today's known set (github, desktop-login, daily-rewards).
- STOP if a migrated route's parity fixture diffs after the default flip without a documented
  knownDeviation.
- STOP if any change would alter the WS wire protocol.
- STOP if determinism or sim-purity would be violated (this phase must not touch src/sim/).
- STOP if the scaffold's emitted code is NOT append-only against error_codes.ts.
- STOP if deleting (rather than retaining behind the flag) the old ladder appears required: that is
  the next-release PR, not this phase.
````
