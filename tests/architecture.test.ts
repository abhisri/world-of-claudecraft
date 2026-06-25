import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Enforces the two load-bearing src/sim invariants from the root CLAUDE.md as a
// real, always-on check instead of convention-only prose: the sim is the
// host-agnostic deterministic core, so it imports nothing from render/ui/game/net
// or Three.js, touches no DOM/browser globals, and draws no randomness or time
// from outside its seeded Rng + sim clock. A violation here means the same
// src/sim code can no longer run unchanged in Node, the browser, and the RL env,
// or that same-seed-same-world determinism is broken. Keep this green.
//
// It also guards the curated PURE CORES the frontend-modernization packet leans
// on: host-agnostic, DOM/Three-free, deterministic modules a Vitest imports
// directly (the unit_portrait.ts template and the per-element view cores hud.ts
// already imports). A registered pure core must not import three, a host layer it
// has no business in, or a DOM-owning *_painter / painter_host sibling: the
// core/painter split is the whole point, so a core reaching for a painter is the
// same hazard one import hop removed. The painters / DOM consumers themselves are
// deliberately NOT registered. Two allowlists, because the cores live in two
// layers: UI_PURE_CORES under src/ui, and RENDER_PURE_CORES for the one
// render-resident logic core (cast_bar, which the painter draws, while the core
// stays Three- and i18n-free).
//
// SCOPE OF THE SCAN: it is PER FILE, not transitive. A registered core's own
// import specifiers are checked, so "pure core" means this file's own surface is
// host-agnostic and unit-testable, not that its whole dependency closure is
// DOM-free (a core may import a sibling ui module like ./i18n that itself touches
// the DOM). That is fine: the load-bearing hazard this gate targets is a core
// reaching directly for three / a *_painter / painter_host, which IS caught.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const simRoot = join(repoRoot, 'src', 'sim');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

// Blank out comments while preserving line count and column positions, so prose
// (a code comment that names Math.random, or "the search window") cannot create a
// false positive. String literals are left intact: the dotted patterns matched
// below (Math.random, window., ...) do not appear inside the sim's player text.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// A specifier a host-agnostic sim file must never import. Returns the offending
// layer/package, or null when the import is allowed.
function forbiddenImport(spec: string): string | null {
  if (spec === 'three' || spec.startsWith('three/')) return 'three';
  const layer = spec.match(/(?:^|\/)(render|ui|game|net)\//);
  return layer ? layer[1] : null;
}

// Same idea for a src/ui pure core: it lives in ui and may lean on sibling pure
// ui modules + host-agnostic sim types, so only three + render/game/net are
// forbidden layers. It also must not import a DOM-owning painter or the painter
// host: a core reaching for a *_painter / painter_host module couples to the DOM
// one hop removed, defeating the split.
function forbiddenUiCoreImport(spec: string): string | null {
  if (spec === 'three' || spec.startsWith('three/')) return 'three';
  const layer = spec.match(/(?:^|\/)(render|game|net)\//);
  if (layer) return layer[1];
  if (/(?:^|\/)(?:[a-z0-9_]+_painter|painter_host)$/.test(spec)) return 'painter';
  return null;
}

// Same idea for a render-resident pure logic core (cast_bar): it lives in render,
// so a render sibling import is allowed, but it must stay Three-free (the painter
// owns the Three drawing) and must not import game/net or a DOM-owning painter.
function forbiddenRenderCoreImport(spec: string): string | null {
  if (spec === 'three' || spec.startsWith('three/')) return 'three';
  const layer = spec.match(/(?:^|\/)(game|net)\//);
  if (layer) return layer[1];
  if (/(?:^|\/)(?:[a-z0-9_]+_painter|painter_host)$/.test(spec)) return 'painter';
  return null;
}

const IMPORT_RE = /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
const DYN_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const DOM_GLOBAL_RE = /\b(document|window|navigator|localStorage|sessionStorage)\s*[.[]/;
const NONDETERMINISM_RE = /\b(Math\.random|Date\.now|performance\.now)\b/;

const simFiles = walk(simRoot);

// Curated src/ui pure cores: host-agnostic view models hud.ts imports, each
// paired with a DOM painter that is deliberately NOT registered here. Seeded with
// the cores that already exist on v0.16.0; extend as new pure cores land (the
// later HUD-extraction phases). The forbiddenUiCoreImport guard forbids three +
// render/game/net + a DOM-owning painter, so it also fits a render-importable
// game LEAF: src/game/ui_effects_profile.ts is a pure resolver that imports
// nothing (gfx.ts imports its EFFECTS_QUALITY_LOW_CUTOFF, a render->game leaf
// import), so it is registered here even though it lives in src/game. Paths are
// repo-relative for the failure messages.
const UI_PURE_CORES = [
  'src/ui/unit_portrait.ts',
  'src/ui/xp_bar.ts',
  'src/ui/absorb_bar.ts',
  'src/ui/party_frames.ts',
  'src/ui/rest_indicator.ts',
  'src/ui/low_health.ts',
  'src/ui/low_resource.ts',
  'src/ui/clock.ts',
  'src/ui/compass.ts',
  'src/ui/coords.ts',
  'src/ui/quest_tracker.ts',
  'src/ui/delve_map.ts',
  'src/ui/raid_lockout_view.ts',
  'src/ui/stat_tooltip_view.ts',
  'src/ui/vendor_view.ts',
  'src/game/ui_effects_profile.ts',
].map((rel) => join(repoRoot, rel));

// Pure logic cores that live in src/render (the painter half is Three-side). Just
// cast_bar today: it emits the cast-bar state from sim types with no Three import
// and no i18n, so the painter can draw it and a Vitest can drive it directly.
const RENDER_PURE_CORES = ['src/render/cast_bar.ts'].map((rel) => join(repoRoot, rel));

function importSpecs(src: string): string[] {
  const specs: string[] = [];
  for (const m of src.matchAll(IMPORT_RE)) specs.push(m[1]);
  for (const m of src.matchAll(DYN_IMPORT_RE)) specs.push(m[1]);
  return specs;
}

function scanImports(files: string[], forbid: (spec: string) => string | null): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const spec of importSpecs(src)) {
      const bad = forbid(spec);
      if (bad) violations.push(`${relative(repoRoot, file)} imports '${spec}' (${bad})`);
    }
  }
  return violations;
}

function scanLines(files: string[], re: RegExp): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (re.test(line)) violations.push(`${relative(repoRoot, file)}:${i + 1}  ${line.trim()}`);
    });
  }
  return violations;
}

describe('src/sim architecture invariants', () => {
  it('finds the sim source tree', () => {
    expect(simFiles.length).toBeGreaterThan(10);
  });

  it('imports nothing from render/ui/game/net or three (host-agnostic core)', () => {
    const violations = scanImports(simFiles, forbiddenImport);
    expect(violations, `src/sim must stay host-agnostic:\n${violations.join('\n')}`).toEqual([]);
  });

  it('touches no DOM/browser globals', () => {
    const violations = scanLines(simFiles, DOM_GLOBAL_RE);
    expect(
      violations,
      `src/sim must run headless (no DOM globals):\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('draws no randomness or wall-clock time outside Rng + the sim clock', () => {
    const violations = scanLines(simFiles, NONDETERMINISM_RE);
    expect(
      violations,
      `all sim randomness/time goes through Rng (src/sim/rng.ts) and the sim clock:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});

describe('src/ui pure-core invariants', () => {
  it('lists only files that exist (the curated pure cores)', () => {
    const missing = UI_PURE_CORES.filter((f) => !statSync(f).isFile());
    expect(missing, `curated src/ui pure core missing:\n${missing.join('\n')}`).toEqual([]);
  });

  it('imports nothing from render/game/net, three, or a DOM-owning painter (host-agnostic, unit-testable)', () => {
    const violations = scanImports(UI_PURE_CORES, forbiddenUiCoreImport);
    expect(
      violations,
      `src/ui pure cores must stay host-agnostic:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('touches no DOM/browser globals', () => {
    const violations = scanLines(UI_PURE_CORES, DOM_GLOBAL_RE);
    expect(
      violations,
      `src/ui pure cores must run headless (no DOM globals):\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('draws no randomness or wall-clock time (deterministic: same input -> same output)', () => {
    const violations = scanLines(UI_PURE_CORES, NONDETERMINISM_RE);
    expect(
      violations,
      `src/ui pure cores must be deterministic (no Math.random/Date.now/performance.now):\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});

describe('src/render pure-core invariants', () => {
  it('lists only files that exist (the curated pure cores)', () => {
    const missing = RENDER_PURE_CORES.filter((f) => !statSync(f).isFile());
    expect(missing, `curated src/render pure core missing:\n${missing.join('\n')}`).toEqual([]);
  });

  it('imports nothing from game/net, three, or a DOM-owning painter (Three-free, unit-testable)', () => {
    const violations = scanImports(RENDER_PURE_CORES, forbiddenRenderCoreImport);
    expect(
      violations,
      `src/render pure cores must stay Three-free:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('touches no DOM/browser globals', () => {
    const violations = scanLines(RENDER_PURE_CORES, DOM_GLOBAL_RE);
    expect(
      violations,
      `src/render pure cores must run headless (no DOM globals):\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('draws no randomness or wall-clock time (deterministic: same input -> same output)', () => {
    const violations = scanLines(RENDER_PURE_CORES, NONDETERMINISM_RE);
    expect(
      violations,
      `src/render pure cores must be deterministic (no Math.random/Date.now/performance.now):\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
