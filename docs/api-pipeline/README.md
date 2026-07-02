# API Pipeline Re-Architecture: planning packet

This packet re-architects every JSON endpoint on the authoritative game server (`server/`)
behind one in-house request pipeline. The goal is maintainability, security, testability,
and observability, not concurrency scaling (the single-threaded 20 Hz world loop is the
real per-realm ceiling and is a separate, out-of-scope workstream), not a gameplay change,
and not a WebSocket wire change. No heavy web framework, zero new runtime dependencies (the
one weighed exception is `prom-client`, and only when the `/metrics` exporter lands in Phase
23). Delivery is a stacked PR chain: 26 implementation phases (25 planned plus the 18b
late-arrivals insert), each paired with a QA phase, each its own green and bisectable PR
that keeps the suite green at every commit and stays under a roughly 40%-context-per-phase
bound. The new pipeline sits in front of the old ladders via per-path catch-all delegates
(four flag-gated dispatchers as of Phase 18: /api, /admin/api, /oauth, and /internal, whose
delegate is the composite that tries the daily-rewards ops sub-dispatcher first) so
partially migrated states stay correct, and the old ladders are retained until Phase 25
names the metric exit criteria for their deletion in a later release. Route families that
arrive via release merges AFTER their would-have-been migration wave (github at v0.18.0;
desktop-login and daily-rewards at v0.19.0) are owned by Phase 18b, which must land before
Phase 25's deletion (and ideally before Phase 19's limiter rework).

## Start here (cross-phase docs)

Read these before opening any single phase. They are the shared context every phase file
assumes.

| File | What it is |
|---|---|
| [brainstorm.md](brainstorm.md) | The raw option exploration and trade-off reasoning behind the locked decisions. |
| [implementation-plan.md](implementation-plan.md) | The end-to-end plan: phase sequencing, the stacked-PR delivery model, and the locked architecture. |
| [progress.md](progress.md) | Running progress log across phases (what has shipped, what is in flight). |
| [state.md](state.md) | Current execution state: the active phase and any open questions or carryover. |
| [qa-checklist.md](qa-checklist.md) | The shared QA checklist each `phase-NN-qa.md` instantiates against its diff. |
| [source-spec.md](source-spec.md) | The originating SPEC this packet decomposes. Its `main.ts`/`db.ts` line anchors are stale; re-anchor on symbol names. |

## Phase index (ordered)

Each implementation phase `phase-NN-<slug>.md` is paired with its QA phase `phase-NN-qa.md`.
Work them in order: a phase depends on the spine and harness the earlier phases land. The
`ctx` column is the synthesis context-risk estimate; every phase must stay under roughly 40%
of a context window, and the phases flagged for an internal a/b split (08, 09, 17, 23) say
so in their own file when the session runs hot.

| NN | Phase | QA | ctx |
|----|-------|----|-----|
| 01 | [Importable spine + WS-auth extraction (the gate, zero behavior change)](phase-01-importable-spine.md) | [QA](phase-01-qa.md) | low |
| 02 | [Shared test scaffolding harness (the phase the SPEC is missing)](phase-02-test-harness.md) | [QA](phase-02-qa.md) | medium |
| 03 | [Surface re-inventory, content-type classification + characterization/golden corpus](phase-03-surface-inventory.md) | [QA](phase-03-qa.md) | medium |
| 04 | [Table router (server/http/router.ts)](phase-04-router.md) | [QA](phase-04-qa.md) | low |
| 05 | [Onion compose + request context (compose.ts + context.ts)](phase-05-onion-context.md) | [QA](phase-05-qa.md) | low |
| 06 | [Typed schema validator (schema.ts)](phase-06-schema-validator.md) | [QA](phase-06-qa.md) | low |
| 07 | [RFC 9457 error model + per-surface serializers + error_codes catalog](phase-07-error-model.md) | [QA](phase-07-qa.md) | medium |
| 08 | [Core middleware set + metric/log hook seam + thin rateLimit adapter](phase-08-middleware.md) | [QA](phase-08-qa.md) | medium |
| 09 | [Registry + dispatcher-in-front + dual-path parity harness + top-level CORS wrapper](phase-09-registry-parity.md) | [QA](phase-09-qa.md) | medium |
| 10 | [Migrate public reads (server/leaderboard.ts)](phase-10-public-reads.md) | [QA](phase-10-qa.md) | medium |
| 11 | [Migrate auth (register/login/native-attestation)](phase-11-auth.md) | [QA](phase-11-qa.md) | low |
| 12 | [Migrate character ownership + BOLA seam (server/characters.ts)](phase-12-characters-bola.md) | [QA](phase-12-qa.md) | medium |
| 13 | [Migrate account portal (server/account.ts) + em-dash fix](phase-13-account.md) | [QA](phase-13-qa.md) | medium |
| 14 | [Migrate wallet + cards (server/wallet.ts)](phase-14-wallet.md) | [QA](phase-14-qa.md) | medium |
| 15 | [Migrate reports + telemetry + misc (server/reports.ts)](phase-15-reports-telemetry.md) | [QA](phase-15-qa.md) | low |
| 16 | [Migrate Discord family (server/discord.ts), net-new since the SPEC](phase-16-discord.md) | [QA](phase-16-qa.md) | medium |
| 17 | [Migrate Admin API onto the shared seam (server/admin.ts)](phase-17-admin.md) | [QA](phase-17-qa.md) | high |
| 18 | [Migrate OAuth JSON + Internal onto the shared seam (oauth.ts + internal.ts)](phase-18-oauth-internal.md) | [QA](phase-18-qa.md) | medium |
| 18b | [Migrate the late-arrival families: github, desktop-login, daily-rewards (net-new via release merges)](phase-18b-late-arrivals.md) | [QA](phase-18b-qa.md) | medium |
| 19 | [Two-tier rate limiter + ratelimit_db (cross-cutting, deep)](phase-19-rate-limiter.md) | [QA](phase-19-qa.md) | medium |
| 20 | [World Market realm-scope fix + partitioned backfill (own PR, migration-safety)](phase-20-market-realm-fix.md) | [QA](phase-20-qa.md) | medium |
| 21 | [Security headers top-level wrapper + Content-Type/Origin enforcement](phase-21-security-headers.md) | [QA](phase-21-qa.md) | low |
| 22 | [REST i18n matcher + per-surface code-parity guard](phase-22-rest-i18n.md) | [QA](phase-22-qa.md) | medium |
| 23 | [Structured logging + /metrics exporter + drain-aware health](phase-23-logging-metrics.md) | [QA](phase-23-qa.md) | medium |
| 24 | [Validated config + server timeouts + no-magic-values consolidation + perf gate](phase-24-config-timeouts.md) | [QA](phase-24-qa.md) | low |
| 25 | [Docs + new:endpoint scaffold + flag-default flip](phase-25-docs-flag-flip.md) | [QA](phase-25-qa.md) | low |

## Ground rules every phase keeps

- Server-only work. It must not touch `src/sim/` (Phase 22 is the one client-side touch:
  the `userFacingApiError` matcher in `src/main.ts` plus the `apiError.*` catalog).
- The same `src/sim/` core runs all three hosts, so determinism and sim purity stay intact;
  Phase 2 injects a `now()` clock so limiter tests are deterministic.
- Every player-visible string is a `t()` key in every locale. The server stays
  language-agnostic and emits a stable machine code re-localized at the client boundary.
- No em dashes, en dashes, or emojis anywhere (code, comments, docs, commits, copy).
- Conventional Commits with a scope. Commit with explicit paths, never `git add -A`, because
  the worktree is shared by concurrent sessions.
- Each phase is a PR; the pre-merge gate mirrors CI (`npm test`, `npx tsc --noEmit`,
  `npm run build:env`, `npm run build:server`, `npm run build`). Run `/qa` over the diff and
  dispatch only the reviewers whose surfaces the phase actually touches.
