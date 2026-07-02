# Phase 22: REST i18n matcher + per-surface code-parity guard

Phase 22 closes the last localization gap the migration opened: the live REST error matcher
`userFacingApiError` in the game CLIENT (`src/main.ts`) still reverse-matches English prose and is
currently UNGUARDED (the S3 guard `tests/localization_fixes.test.ts` scans only the WS path via
`server/game.ts`). This phase INTRODUCES the stable machine CODES on the migrated surfaces (the
waves shipped PARITY-FIRST PROSE per the ratified canonical rule, so this phase owns coded
emission, not just consumption) and reworks the matcher to look them up, porting the parametric cases
(account-suspended `{date}`, the `{seconds}` rate-limit families) to `{code, params}` formatted
client-side, adds an `apiError.*` English catalog domain, and adds a per-surface code-parity Vitest
that asserts every server-emitted code resolves to a client entry in every locale (append-only
frozen), covering the ~30 to 45 EXISTING REST strings plus the new Discord and guild codes.

It is sized to stay under 40% context because the surface is narrow: one client function
(`userFacingApiError`), one declarative catalog domain (data-as-code, exempt from the
logic-monolith concern), one bounded server-side coded-emission pass over the already-migrated
handlers (flag-gated, parity-pinned), and one focused test sweep. There is no documented a/b
split for this phase.

The implementation Starter Prompt below is self-contained. A fresh Claude Code session can paste
and run it without reading this table of contents.

### Starter Prompt

````text
This is Phase 22 of the API Pipeline re-architecture: REST i18n matcher + per-surface code-parity
guard.
Model: Opus 4.8, xhigh effort. Harness: Claude Code.
ULTRACODE: this phase is NOT batch-heavy (one client function, one catalog domain, one parity
test). Do NOT use ultracode. Hand-spawn 3 parallel agents as named in STEP 2.
Goal: rework the client REST error matcher userFacingApiError (src/main.ts) to localize by the
stable problem+json CODE instead of reverse-matching English prose, add the apiError.* English
catalog domain, and add a code-parity Vitest asserting every server-emitted code resolves in every
locale (append-only frozen), covering the existing ~30 to 45 REST strings plus the new Discord and
guild codes, while preserving the matcher's prose fallback for un-migrated old-ladder routes and
its WS-disconnect-reason role.

STEP 0 - PRE-FLIGHT
- Run `git status`. The worktree is SHARED with concurrent sessions. If it is dirty with files
  outside this phase's scope (anything not under src/main.ts, src/ui/i18n.catalog/,
  tests/api_error_code_parity.test.ts, tests/main_api_error.test.ts, docs/api-pipeline/), STOP and
  ask before touching anything.
- Confirm the prior phases shipped on the base branch: the error model + error_codes.ts catalog
  (Phase 7), the migration phases' parity-first PROSE surfaces (Phases 10 to 18b; they do NOT
  emit codes yet, that premise shifted and this phase owns coded emission), and the
  account-portal em-dash fix that ALREADY landed in Phase 13 (the U+2014 rate-limit strings are
  already commas and userFacingApiError already resolves them). If server/http/error_codes.ts does
  not exist, STOP: this phase consumes it.
- Scan Claude Code memory for entries in this phase's domain. Suggested concrete topics:
  "REST matcher userFacingApiError unguarded", "i18n resolved baseline and assembly",
  "M16 wordy-English requires non-Latin fills", "i18n reword-staleness blind spot".

STEP 1 - LOAD CONTEXT (do NOT read the planning docs or src/main.ts directly yourself; spawn ONE
Explore agent and consume only its summary)
Tell the Explore agent to summarize, anchored on SYMBOL NAMES and CODE STRINGS (never line numbers;
src/main.ts is ~6.4k lines and churns):
- docs/api-pipeline/state.md and docs/api-pipeline/progress.md (the full registered error-code set
  to date, the per-surface envelope decisions, which migration phases emit which codes, and any
  codes prior phases flagged "wire the client matcher in Phase 22").
- docs/api-pipeline/phase-22-rest-i18n.md (this file).
- src/main.ts: the `userFacingApiError(err)` function and the `technicalErrorMessage(err)` helper it
  calls. Return EVERY current branch: the parametric `^This account is suspended until (.+)\.$`
  case, the `startsWith('too many attempts')` and `startsWith('too many failed attempts')` cases,
  every exact-prose case and the t() key it maps to (errors.api.*, hudChrome.account.*), the
  desktop-login arm (errors.api.desktopCodeInvalid, added with the v0.19.0 desktop feature and fed
  by loginError(userFacingApiError(err)) in both desktop flows), the WS-disconnect-reason branches
  (loading.connectionLost / loading.connectionRejected, the tServer moderation.* kicks), and the
  diagnostic branches that intentionally stay English. Also return how a caught REST error
  currently carries (or does NOT carry) the problem+json `code` field on the thrown object: name
  the field the migration phases put the code in. KNOWN ADJUDICATIONS THIS PHASE OWNS: (a) the
  Phase 18b families are parity-first PROSE (no codes), so they are prose-fallback dependents that
  BLOCK the fallback removal until the ladder deletion; (b) the daily-rewards prose family
  ('daily rewards are locked for this wallet', 'daily spin already claimed', the family 404
  'unknown endpoint') deliberately has NO matcher arm because the client provably discards the
  bodies (src/net/online.ts dailyRewards()/spinDailyReward() + the window's generic
  hudChrome.dailyRewards.error card): record the out-of-scope adjudication with those citations,
  or add the arms if a surface starts rendering the prose; (c) 'this token is read-only'
  (bearerActiveAccount's 403 on every full-scope route) has NO matcher arm anywhere: unreachable
  from the game client today, but it deserves a code + apiError.* entry in this phase's sweep; (d)
  the suspended-until `{date}` param is the server's raw toUTCString English date: the {code,
  params} port should format it client-side via formatDateTime.
- server/http/error_codes.ts: the as-const (domain, reason) catalog and its param keys, plus its
  append-only test, so the parity guard can enumerate EVERY server-emitted code from the single
  source of truth.
- server/http/errors.ts: mapError and how the problem+json serializer places the stable `code` (and
  any params) in the response body, so the client knows the exact wire shape to read.
- src/ui/i18n.catalog/index.ts (catalog barrel: how a domain registers), src/ui/i18n.catalog/game.ts
  (the existing errors.api.* keys), src/ui/i18n.catalog/hud_chrome.ts (the English-only
  hudChrome.account.* keys the matcher reuses). Return where a NEW apiError.* domain should be added
  and how it is wired into the barrel.
- src/ui/i18n.ts: t(), formatNumber, formatDateTime, formatMoney, ensureLocaleLoaded, and whether a
  formatDuration helper exists (if not, note it; the {seconds} families need a client-side duration
  format). src/ui/server_i18n.ts (tServer + the WS DICT) and src/ui/sim_i18n.ts (to NOT touch).
- tests/localization_fixes.test.ts (the S3 guard): how it scans server/game.ts and WHY it does not
  cover the REST userFacingApiError matcher (the gap this phase closes).
- src/ui/CLAUDE.md (catalog layout, the hud_chrome English-only exception, the formatters, the
  matcher rules, the M16 wordy-English non-Latin-fill exception), server/CLAUDE.md, root CLAUDE.md
  (the every-player-string-is-a-t()-key invariant; contributors add English only).
The Explore agent returns: the FULL enumerated set of server-emitted stable codes (domain.reason +
param keys); the exact problem+json field carrying the code; the current userFacingApiError branch
map (prose -> t() key, including the parametric and WS-disconnect branches); the apiError.* domain
registration mechanism and the en module to add into; the client formatters + ensureLocaleLoaded;
how the S3 guard scans and why it misses the REST matcher; and the M16 wordy-English rule. It reads
the planning docs so the implementers never do.

STEP 2 - CHOOSE ORCHESTRATION + EXECUTE
Hand-spawn 3 parallel agents, each owning a complete vertical slice (behavior PLUS its tests), each
given ONLY the Explore summary. All three depend on ONE shared artifact: the code-to-apiError-key
mapping table (one apiError.<key> per server-emitted code, derived from error_codes.ts). Agent B
publishes that mapping in its first message; A and C consume it. This phase has NO documented a/b
split; do not split it. If your own context approaches 40%, checkpoint the mapping table to
docs/api-pipeline/progress.md and resume.

- Agent B (the apiError.* catalog, publishes the mapping FIRST):
  - Add the apiError.* English catalog domain to src/ui/i18n.catalog/ (a new domain module, or the
    existing errors.api.* domain extended, per the Explore summary's registration mechanism). Add
    ONE English entry per server-emitted code from error_codes.ts, wired into the catalog barrel so
    t('apiError.<key>') resolves. Add ENGLISH ONLY; never edit src/ui/i18n.locales/<lang>.ts overlays
    (the build English-fills omissions and marks them pending at release).
  - For the parametric codes, the English value carries the placeholder the matcher will fill:
    account-suspended uses {date}, the rate-limit families use {seconds} (the matcher passes
    client-formatted values, see Agent A). Numbers/dates/durations are NEVER pre-formatted in the
    string.
  - M16 EXCEPTION (the one allowed locale-overlay touch): for any NEW apiError.* English value that
    is WORDY (a word of 4+ lowercase letters), add the five non-Latin fills (zh, zh_TW, ja, ko, ru)
    in the SAME change. Short codes (a single short token) ship English-only (pending). Run the S3 /
    M16 gate to find which values are flagged wordy.
  - Regenerate the resolved i18n catalog the way the build does (the i18n build English-fills and
    marks pending) so the new keys resolve at runtime.
  - Deliverable bullets: the apiError.* domain + barrel wiring; one English entry per code; the
    parametric placeholders; the M16 non-Latin fills for wordy values; the regenerated resolved
    catalog; the published code-to-apiError-key mapping table.

- Agent A (the matcher rework, src/main.ts):
  - Extend userFacingApiError: when the caught error carries a stable problem+json `code` (the field
    named in the Explore summary), look it up DIRECTLY via t('apiError.' + the mapped key) using the
    Agent B mapping. This is the PRIMARY path now.
  - Preserve the legacy prose-matching branches as a FALLBACK for un-migrated old-ladder routes,
    which still emit raw English through the catch-all delegate until the old ladder is deleted next
    release. Resolution order: code first, prose fallback second, raw diagnostic English last.
  - Port the parametric cases to {code, params}: account-suspended -> t('apiError.<suspendedKey>',
    {date}) with the date formatted client-side via formatDateTime/Intl; the {seconds} rate-limit
    families (too-many-attempts, too-many-failed, any rate.* code) -> the matching apiError key with
    {seconds} formatted client-side via the duration formatter (formatDuration if it exists, else
    formatNumber plus a unit key or Intl; confirm via the Explore summary, add a small client helper
    only if none exists). The server NEVER formats the number or date.
  - Preserve the matcher's DUAL role unchanged: the WS-disconnect-reason branches (loading.*,
    tServer moderation.*) and the intentionally-English diagnostic branches stay exactly as they are.
  - tests/main_api_error.test.ts: a code-bearing problem+json error resolves via apiError.<key>; an
    un-migrated raw-English error still resolves via the prose fallback; the parametric date and
    duration cases interpolate and are formatted client-side (not pre-formatted); a WS-disconnect
    reason still resolves via tServer/loading.* unchanged; a pure diagnostic error stays English.
  - Deliverable bullets: code-first lookup with prose fallback; the two parametric {code,params}
    ports with client-side formatting; preserved WS-disconnect + diagnostic branches; the matcher
    test file.

- Agent C (the per-surface code-parity guard, tests/):
  - tests/api_error_code_parity.test.ts: enumerate EVERY server-emitted stable code from
    server/http/error_codes.ts (the single source of truth; never a hand-copied list). For each code,
    assert t('apiError.' + the mapped key) resolves to a NON-EMPTY client entry in EVERY locale (the
    resident en plus each overlay / English-fill via ensureLocaleLoaded). Cover the ~30 to 45 EXISTING
    REST strings (the errors.api.* and hudChrome.account.* set the matcher maps today) AND the new
    Discord and guild codes.
  - Assert APPEND-ONLY frozen: a snapshot list of the known codes; new codes may only be appended
    (AIP-193), mirroring the error_codes.ts append-only test. A removed or reordered code fails.
  - The failure message MUST name the EXACT apiError.<key> English key the contributor has to add
    when a server code has no client entry (testFocus: the guard tells you precisely what to add).
  - Deliverable bullets: the enumerate-from-error_codes.ts parity assertion; every-locale resolution;
    existing-strings + Discord/guild coverage; append-only freeze; the precise failure message.

After the three land, integrate: confirm the parity guard (C) is GREEN against the catalog (B) and
the matcher (A) resolves both a code-bearing and a raw-English error. The guard is the gate that
proves A and B are complete.

INVARIANTS THIS PHASE MUST KEEP
- Stable-code i18n: the server stays language-agnostic (it emits a stable CODE, never English in the
  body the client localizes); the client localizes by code via t('apiError.<key>'), never by parsing
  detail, never by concat, ?? 'English' fallback, or a default param. Numbers/dates/durations format
  client-side via formatNumber/formatDateTime/formatDuration/Intl.
- Contributors add ENGLISH only: new apiError.* keys go in the en catalog module; NEVER edit
  src/ui/i18n.locales/<lang>.ts overlays. The ONE exception is the M16 wordy-English non-Latin fills
  (zh/zh_TW/ja/ko/ru) for a new wordy value, in the same change.
- Single-flag dispatch + catch-all delegate: un-migrated old-ladder routes still emit raw English;
  the matcher's prose fallback MUST stay so those errors keep resolving until the old ladder is
  deleted next release. Do not remove a prose branch whose route is not yet migrated.
- Append-only frozen code set (AIP-193): the parity guard freezes the known codes; new codes append
  only. The matcher reuses the existing errors.api.* / hudChrome.account.* / domain.reason vocabulary.
- No magic values: the code-to-apiError-key mapping is ONE declarative table, not scattered literals.
- Determinism / sim-purity: this phase is CLIENT plus TESTS only. Do NOT import or touch src/sim/.
  No Math.random/Date.now in tested logic.
- No em dashes, en dashes, or emojis anywhere (code, comments, tests, docs, commits).
- No WS wire change. No server behavior change. No DDL.

OUT OF SCOPE (do not do these here)
- The em-dash rate-limit string fix and the account-portal prose mapping: ALREADY shipped in Phase
  13. Here, only ensure the already-comma'd rate-limit strings still resolve under code-lookup with
  prose fallback; do NOT re-edit those strings.
- Adding NEW server endpoints: the migration phases (10 to 18b) own the route surface. NOTE the
  premise shift ratified during the migration waves: the phases shipped PARITY-FIRST PROSE, not
  coded emission, so THIS phase owns introducing the coded emission on the migrated surfaces plus
  the apiError.* entries (the canonical rule in state.md wins over this file's older
  "consumes-only" framing). The Phase 18b late arrivals (github, desktop-login, daily-rewards) are
  prose-only until this phase codes them or records their adjudication (see the known-adjudications
  list in STEP 1).
- The WS-only server_i18n / sim_i18n matchers: those localize WS sim/server text and are guarded by
  S3 already. Preserve userFacingApiError's existing WS-disconnect branches, but do NOT rework
  server_i18n or sim_i18n here.
- Structured logging + /metrics (Phase 23); validated config + no-magic-values consolidation
  (Phase 24); docs + new:endpoint scaffold + flag-default flip (Phase 25).
- No src/sim change. No WS wire change. No DDL. No admin-dashboard i18n (en_CA operator copy is
  Phase 13).

STEP 3 - VALIDATION + MULTI-AGENT REVIEW
Validation commands (the canonical matrix for this change type: player text/codes added or changed):
- `npx tsc --noEmit`
- `npx vitest run tests/api_error_code_parity.test.ts tests/main_api_error.test.ts`
- `npx vitest run tests/localization_fixes.test.ts` (S3 stays green; the REST matcher is now ALSO
  guarded by the new parity test)
- Regenerate the resolved i18n catalog the way the build does (the i18n build English-fills new keys
  and marks them pending); confirm pending rows appear for the non-wordy new keys and the five
  non-Latin fills are present for any wordy keys.
- `npm run ci:changed` (Biome on changed files only; never a whole-tree --write)
- `npm run build` (regenerates the resolved i18n + builds all four entries)
- Pre-merge gate (mirror CI): `npm test && npx tsc --noEmit && npm run build:env && npm run
  build:server && npm run build`.
Review-agent dispatch (spawn ONLY surfaces this diff touches; check `git diff --name-only` first):
- cross-platform-sync: REQUIRED. This is THE phase that changes the client i18n matcher mirroring
  server-emitted codes (per the canonical Review dispatch rules, cross-platform-sync fires on the
  client matcher). Prompt it for COVERAGE not filtering: the server stays language-agnostic and the
  client localizes by code; every server-emitted code in error_codes.ts has an apiError.* entry; the
  parametric params reach the client formatter (no server-side number/date formatting); the prose
  fallback still resolves un-migrated old-ladder errors; the WS-disconnect role is unchanged; no
  English prose leaks from the server.
- qa-checklist: at phase completion.
- Do NOT spawn privacy-security-review (the diff is src/main.ts + the catalog + tests; no server
  behavior, auth, BOLA, or SQL change), migration-safety (no DDL/JSONB change), or
  architecture-reviewer (no src/sim change).
Add to every review prompt: "If your output is truncated, resume from the last completed file and
continue; do not restart." Do not commit until each reviewer reports no BLOCKING finding.

STEP 4 - COMMIT CADENCE (Conventional Commits with a scope, EXPLICIT paths, never git add -A)
This phase ships as ONE green, bisectable PR in the stacked chain. Suggested headlines:
- `feat(i18n): add apiError.* English catalog domain for server error codes`
  (paths: src/ui/i18n.catalog/<the apiError module>.ts, src/ui/i18n.catalog/index.ts, the
  regenerated resolved i18n artifact)
- `feat(i18n): localize REST errors by stable code in userFacingApiError with prose fallback`
  (paths: src/main.ts, tests/main_api_error.test.ts)
- `test(i18n): per-surface code-parity guard over server-emitted error codes`
  (paths: tests/api_error_code_parity.test.ts)
- `docs(api-pipeline): record Phase 22 REST i18n matcher + code-parity guard`
  (paths: docs/api-pipeline/progress.md, docs/api-pipeline/state.md)

STEP 5 - ACCEPTANCE CRITERIA (verifiable checkboxes)
- [ ] userFacingApiError looks up an emitted stable code DIRECTLY via t('apiError.<key>') when the
      error carries a problem+json code, and falls back to the existing prose matcher for un-migrated
      old-ladder raw-English errors (code first, prose second, diagnostic English last).
- [ ] The parametric cases (account-suspended {date}, the {seconds} rate-limit families) are ported
      to {code, params} and formatted client-side via formatDateTime/formatDuration/Intl, never
      server-formatted.
- [ ] apiError.* English catalog entries exist for every server-emitted code (the agreed mapping),
      added to the en catalog only; locale overlays untouched EXCEPT the M16 non-Latin fills for any
      WORDY new value.
- [ ] tests/api_error_code_parity.test.ts enumerates every code in server/http/error_codes.ts and
      asserts each resolves in every locale; it covers the ~30 to 45 existing REST strings AND the new
      Discord and guild codes; it enforces append-only; its failure message names the exact
      apiError.<key> English key to add.
- [ ] userFacingApiError's dual role is preserved: the WS-disconnect-reason branches
      (loading.connectionLost/Rejected, the tServer moderation.* kicks) and the intentionally-English
      diagnostic branches still resolve unchanged.
- [ ] The S3 guard (tests/localization_fixes.test.ts) stays green; no English prose is emitted from
      the server; the server stays language-agnostic.
- [ ] No WS wire change; no src/sim import; no DDL; no server behavior change; no em/en dashes or
      emojis.
- [ ] tsc, the new vitest suites, S3, ci:changed, the i18n resolved regeneration, build, and the full
      pre-merge gate are green.

STEP 6 - DOC UPDATES + MEMORY
- docs/api-pipeline/progress.md: mark Phase 22 done; list the new apiError.* catalog domain, the
  userFacingApiError code-lookup rework (with its prose fallback), the new
  tests/api_error_code_parity.test.ts guard, the new tests/main_api_error.test.ts matcher test, and
  the location of the code-to-apiError-key mapping table.
- docs/api-pipeline/state.md: record that the REST matcher is now CODE-based and GUARDED (closing the
  long-standing unguarded-REST-matcher gap, since S3 scanned only the WS path / game.ts), that
  apiError.* is the client-localization home for server codes, the append-only frozen code set, and
  the remaining prose-fallback dependency on the old ladder (removable when the old ladder is deleted
  next release).
- Memory: record the surprising rules: the prose-fallback-until-old-ladder-deleted dependency; the
  M16 wordy-English non-Latin-fill requirement for new apiError.* values; and that the REST matcher
  was historically UNGUARDED.

STEP 7 - FINAL RESPONSE FORMAT
Report: phase status (DONE / BLOCKED); files touched (absolute paths); validation results (tsc, the
new vitest suites, S3, ci:changed, the i18n regeneration, build, full gate, each PASS/FAIL); review
verdicts (cross-platform-sync, qa-checklist); deferrals (any code without a client entry surfaced;
old-ladder prose-fallback removal -> next release); and a one-line handoff to "Phase 22 QA".

STOPPING RULES (stop and surface, do not work around)
- Stop if the parity guard cannot enumerate the full server-emitted code set from
  server/http/error_codes.ts (that means the catalog is not the single source of truth; surface it).
- Stop if extending userFacingApiError to code-lookup would BREAK resolution of an un-migrated
  old-ladder English error (the prose fallback MUST stay).
- Stop if a parametric case ({date}, {seconds}) loses its interpolation or would be formatted
  server-side instead of client-side.
- Stop if a server-emitted code has no client entry and the only way to make it resolve is changing
  the server (add the apiError.* English entry instead; if the code itself is wrong, that is a prior
  migration phase's bug, surface it).
- Stop if you find yourself editing a src/ui/i18n.locales/<lang>.ts overlay for anything OTHER than
  the M16 non-Latin fills of a new wordy English value.
- Stop if any change would alter the WS wire protocol or snapshots.
- Stop if determinism or sim-purity would be violated (any src/sim import; any Math.random/Date.now
  in tested logic).
````
