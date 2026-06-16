# progress.md - i18n Scaling

## Status table
| Phase | Status | Started | Completed |
|---|---|---|---|
| 0 - Layer rename (pre-packet) | DONE | - | (on branch `refactor/i18n-phase-naming`) |
| 1 - Foundation & split | DONE | 2026-06-16 | 2026-06-16 |
| 1 QA | DONE (PASS) | 2026-06-16 | 2026-06-16 |
| 2 - Resolved artifact | DONE | 2026-06-16 | 2026-06-16 |
| 2 QA | NOT STARTED | | |
| 3 - Flatten overlays | DONE | 2026-06-16 | 2026-06-16 |
| 3 QA | NOT STARTED | | |
| 4 - Dialect inheritance | NOT STARTED | | |
| 4 QA | NOT STARTED | | |
| 5 - Status registry | NOT STARTED | | |
| 5 QA | NOT STARTED | | |
| 6 - Unlock + two-tier CI | NOT STARTED | | |
| 6 QA | NOT STARTED | | |
| 7 - Release fill tooling | NOT STARTED | | |
| 7 QA | NOT STARTED | | |
| 8 - Admin catalog | NOT STARTED | | |
| 8 QA | NOT STARTED | | |
| 9 - Pseudo-locale (optional) | NOT STARTED | | |
| 9 QA + teardown | NOT STARTED | | |

## Deliverable checklists

### Phase 1 - Foundation & monolith split
- [x] Authoritative nested `en` + `Leaves`/`TranslationKey`/`DeepPartial` machinery extracted to `src/ui/i18n.en.ts`
- [x] `src/ui/i18n.ts` is the thin runtime; ALL public exports unchanged (`t`, `tOptional`, `hasTranslation`, formatters, `getLanguage`/`setLanguage`, `supportedLanguages`, types)
- [x] Locale data split along seams into separate files (`src/ui/i18n.locales/<code>.ts`, 13 files; behavior-preserving; still nested `: typeof en`)
- [x] `scripts/i18n_resolved_hash.mjs` + committed `src/ui/i18n.resolved.sha256` baseline (`i18n:hash` npm script)
- [x] `tests/i18n_resolved_equivalence.test.ts` asserts the resolved table matches the baseline
- [x] tsc clean; full localization suite green (1239/1239); resolved table byte-identical to pre-change

Commits: `573bd5a` (extract en base + types), `20e8cca` (thin runtime + locale split), `d918244` (byte-equivalence baseline + gate).
Baseline: SHA-256 `d9db528bea1c7a1e02835c4d3edb3fabcee3687aad2186608f1f1d2ac83b3b9b`, 1,584,856 bytes (see state.md for why this differs from the doc's stale 1,583,881).

### Phase 2 - Dense resolved artifact - DONE (2026-06-16)
- [x] `scripts/i18n_build.mjs` overlays locales onto `en`, emits `src/ui/i18n.resolved.generated.ts` (nested, `: EnTranslations` = `typeof en`, do-not-edit banner)
- [x] Client imports the generated artifact through the runtime; `t`/`tOptional`/`hasTranslation`/`translationValue` repointed at the dense table. (Admin: N/A this phase - `src/admin/` is independent of `src/ui` and ships its own flat DICT; the main table is not an admin consumer, so the phase-doc "admin imports the generated artifact" line is a no-op here. Admin catalog is Phase 8.)
- [x] `i18n:build` wired into `npm run build` (before vite) + `pretest`; reproducibility `git diff --exit-code` test green (plus a tracked-file assertion so the gate is not vacuous on an untracked artifact)
- [x] Resolved table byte-identical to Phase 1 output (SHA-256 `d9db528..` unchanged)

Commits: `3f1ed8d` (build script + generated dense table + `EnTranslations` + wiring), `a92ff37` (runtime consumes the dense table), `ffb40e5` (reproducibility test).
Validation: `tsc --noEmit` clean; targeted suite 77/77 (localization_fixes + localization_coverage + server_i18n + i18n_resolved_equivalence); byte-equivalence SHA `d9db528bea1c7a1e02835c4d3edb3fabcee3687aad2186608f1f1d2ac83b3b9b` (14 locales, 1,584,856 bytes); regeneration byte-identical; `npm run build` clean (client + admin).
Bundle delta (locale data now fully inlined, losing cross-locale spread-sharing): main bundle gzip 966.77 -> 1120.64 KB (+153.9 KB, +15.9%); admin bundle unchanged. A naive repoint balloons +479.8 KB gzip because the `gameStrings` re-export dragged the full ~1 MB `i18n.en` base in alongside the inlined table; sourcing `gameStrings` from the generated `en.game` recovers ~326 KB gzip of pure duplication. The residual +154 KB is inherent to a dense table (no cross-locale sharing) plus `world_entity_i18n` entity data being inlined in the table AND still bundled for the `hud`/`entity_i18n` resolver - see state.md gotchas.

### Phase 3 - Flatten non-English locales - DONE (2026-06-16)
- [x] 13 main-table non-English locales converted to flat dotted-key overlays in `src/ui/i18n.locales/<lang>.ts` (`Record<string, string>`, 1925 keys each, dense). Produced by the one-time migration `scripts/i18n_flatten_locales.mjs`; they no longer import `i18n.en`/`world_entity_i18n` (standalone flat literals)
- [x] `en` stays nested + authoritative (`src/ui/i18n.en.ts` untouched); generator unflattens each overlay onto a deep copy of `en` and emits the byte-identical dense artifact
- [x] Overlays still dense (every key present); temporary key-completeness test passes (`tests/i18n_flat_overlay_dense.test.ts`, exact key-set vs `flatten(en)` + non-empty-string values)
- [x] Resolved table byte-identical (SHA-256 `d9db528..` unchanged; generated-file blob `90b4326..` unchanged; `git diff --exit-code` clean)
- [~] DEVIATION (deliberate, sign-off via maintainer "do whatever is best"): the two island files were NOT flattened. `world_entity_i18n.ts` is all-string but has ZERO runtime path-indexers and its non-English data is superseded by the inlined overlays (flattening it would be dead-code churn); its `.en` slice still feeds nested `en`. `talent_i18n.ts` is a SEPARATE channel (not in the byte-frozen table), read at runtime by `hud.ts`/`tTalent`, and its `localeText` has FUNCTION-valued leaves (`chooseOne`/`specDescription`/`grant`/`increase`/`reduce`) that cannot become a flat string map; `titleOverrides` is already a flat string map. Both deferred to Phase 4 (which already owns `world_entity_i18n` dialect/overlay semantics).

Commits: `refactor(i18n): flatten non-English locales to dotted-key overlays` (contract `i18n_flatten.mjs` + build overlay path + migration + 13 overlays), `test(i18n): assert flat overlays match en leaf set and stay dense`, this doc commit.
Validation: `tsc --noEmit` clean; targeted suite 31/31 (flat-overlay-dense + resolved-equivalence) and 77/77 (localization_fixes + localization_coverage + server_i18n + i18n_resolved_equivalence); full suite 1268/1268; `npm run build` (client+admin) + `build:env` + `build:server` clean; byte-equivalence SHA `d9db528..` (14 locales, 1,584,856 bytes) unchanged; regeneration byte-identical. Main bundle gzip 1120.64 KB (unchanged from Phase 2 - overlays are build-time source, not bundled).
Reviews (coverage mode, whole diff): privacy-security-review PASS (no BLOCKING/SHOULD-FIX), cross-platform-sync PASS (no BLOCKING; islands-left-nested confirmed correct), correctness review PASS (round-trip proven total in both directions vs git HEAD; could not break it). Hardening applied from review NICE-TO-HAVEs: `flatten`/`unflatten` now throw on a dotted key segment or a prefix collision (fail-loud instead of silent corruption); neither is reachable in today's data.
Type note: overlays are typed `Record<string, string>`, not `Record<TranslationKey, string>` - `TranslationKey = Leaves<typeof en, 5>` stops at depth 5, but the deepest real leaves (`entities.quests.<id>.objectives.0.label`, `entities.zones.<id>.pois.<n>.label`) are 6 segments deep, so they are not in `TranslationKey`. Key validity is enforced by the temporary completeness test + the byte gate instead.

### Phase 4 - Dialect inheritance dedup
- [ ] `es_ES` overlay carries only divergences from `es`; `fr_CA` only from `fr_FR`; `en_CA` thin alias of `en`
- [ ] Resolver applies base then dialect overlay
- [ ] `{} as WorldEntityTranslations` casts replaced with real overlay semantics
- [ ] Resolved table byte-identical (dedup must not change output)

### Phase 5 - Status registry + scanner
- [ ] `scripts/i18n_scan.mjs` (no LLM/network) walks `en` + matcher + admin keys, computes `srcHash` (English text + sorted placeholders), writes `src/ui/i18n.status.json`
- [ ] Registry states: `translated` (with `srcHash`, `by`), `pending`, `blocked` (with `reason`)
- [ ] `COPIED_ALLOW` / `ALLOW_V07_SLASH` become generated views over the registry
- [ ] `i18n:scan` in build + `pretest`; registry reproducibility + registry-in-sync tests green
- [ ] `pending` set empty at this stage (everything still dense)

### Phase 6 - The unlock: relax types + two-tier CI
- [ ] Flat overlays relaxed to `Partial<Record<TranslationKey,string>>` (sparse legal)
- [ ] `t()` throws on untracked key in dev/test; renders English for `pending` keys on non-release builds only; release build asserts empty `pending`
- [ ] `.github/workflows/ci.yml` split by ref: PR gate (tsc on dense artifact, registry-in-sync, `s3_registered`, placeholder parity for existing) vs release gate (14-locale H3/H3b, copied-English content, `s3_localized`, empty-pending)
- [ ] S3 guard split into `s3_registered` (PR) + `s3_localized` (release); content tests moved to release tier
- [ ] Proof: English-only sample key passes PR tier; deliberately incomplete locale fails release tier

### Phase 7 - Release fill worklist + docs
- [ ] `scripts/i18n_fill_worklist.mjs` emits per-language `pending` delta (`{key, english, placeholders, siblings}`), one batch per language
- [ ] Locked-terms glossary shipped with the worklist
- [ ] Contributor + maintainer workflow documented (in `src/ui/CLAUDE.md` and/or `docs/`)
- [ ] Worklist round-trip: fill an overlay -> scan -> `pending` shrinks

### Phase 8 - Admin catalog into the model
- [ ] `src/admin/i18n.ts` brought under the overlay + registry + release-gate model (English-only admin PRs legal; 14-locale completeness gated at release)
- [ ] Hardcoded `window.alert(...)` at ~`src/admin/main.ts:401` localized
- [ ] Admin renders all 14 locales; admin build clean; non-client-consumer audit (RFC §9.7) passes

### Phase 9 - `en_XA` pseudo-locale (optional)
- [ ] Generated accent/bracket pseudo-locale over every `en` leaf, selected via `?lang=en_XA`
- [ ] Excluded from `supportedLanguages`, hreflang, and the release gate
- [ ] Surfaces hard-coded literals that never became `t()` keys

## QA-phase checklists (fixes applied, tests added, dead code removed)
Filled in by each QA session.

### Phase 1 QA - PASS (2026-06-16)
Verdict: PASS. Issues found: 6, all NICE-TO-HAVE; fixed: 0; deferred: 6. No BLOCKING or SHOULD-FIX. No source changes were needed, so no fix commit.
- Method: 1 context loader + 5 parallel read-only audits (correctness, dead-code/cleanup, privacy-security-review, cross-platform-sync, qa-checklist), all PASS, plus a test-coverage mutation proof run directly in the main loop.
- Validation matrix, all green: `tsc --noEmit`; `vitest run` of localization_fixes + localization_coverage + server_i18n + i18n_resolved_equivalence (4 files, 75 tests); byte-equivalence gate SHA `d9db528bea1c7a1e02835c4d3edb3fabcee3687aad2186608f1f1d2ac83b3b9b` (14 locales, 1,584,856 bytes); `npm run build` (client + admin).
- Mutation proof (the gate is meaningful, not vacuous): temporarily changed one inline `es` value (`nav.home` "Inicio" to "InicioQA"); the resolved SHA changed to `e2f70bc8...`, `--check` exited 1, and both equivalence tests went red. Reverted via explicit-path `git checkout`; SHA and tests green again.
- Behavior-preserving confirmed against pre-work commit `a9a1a67`: the `./i18n` public export surface is unchanged name-for-name and signature-for-signature (only additive new export `DeepPartial`); thin-runtime function bodies (t, tOptional, hasTranslation, interpolate, formatMoney/moneyParts, getLanguage/setLanguage, formatNumber/formatDateTime) are byte-identical to the monolith; `en` still nested and authoritative; 13 locales still nested `: typeof en`; `src/sim` import invariant intact (`world_entity_i18n` imports only `../sim/data`).
- Deferred NICE-TO-HAVE for later phases: (1) shared content layers + per-locale gameStrings variants + `DeepPartial` are now `export` on `i18n.en` (necessary so locale files can spread them; NOT on the public `./i18n` barrel, so the surface stays unchanged); (2) `tsconfig` `noUnusedLocals:false` will not catch a future orphaned layer import once Phase 3 churns the locale files; (3) hash script `data:`-URL import is safe but obscures parse errors and skips the module cache (dev/CI tooling only); (4) the byte-equivalence gate covers locale data only, not the runtime function/type surface (tsc covers that); (5) cosmetic `./` vs `../` worldNames import path differs between the en base and the locale files (same module).

## Notes (per phase, post-completion)
- Phase 0: pure rename, verified byte-identical resolved table (SHA-256), 73 localization tests green. Prerequisite readability step, already on the branch.
