import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { NAMEPLATE_INTERVAL_LOW_SEC, nameplateIntervalSec } from '../src/game/ui_tier_knobs';
import {
  classifyGpuRenderer,
  configureMaskedDoubleSidedVegetationMaterial,
  forcedTierFromSearch,
  GFX_BUCKET_BANDS,
  GFX_BUDGETS,
  type GfxRuntimeHints,
  gfxInternalsForTest,
  graphicsPresetLabel,
  isConstrainedBrowser,
  isWeakIntegratedGpu,
  resolveDefaultGraphicsPreset,
  shouldUseAutoGovernor,
  tierFromHints,
} from '../src/render/gfx';

const desktop: GfxRuntimeHints = {
  search: '',
  maxTouchPoints: 0,
  coarsePointer: false,
  narrowViewport: false,
};

describe('graphics tier resolution', () => {
  it('keeps the pre-persist module-load best-guess (unset preset) device-agnostic at ultra', () => {
    // graphicsPresetLabel + tierFromHints stay device-agnostic (the options-UI label resolver
    // and the module-load best-guess). The device-aware FIRST-RUN default lives in
    // resolveDefaultGraphicsPreset (tested below) + main.ts persist, which writes a concrete
    // preset before the renderer re-resolves, so this unset path is only the transient guess.
    expect(desktop.graphicsPreset).toBeUndefined();
    expect(graphicsPresetLabel(desktop.graphicsPreset)).toBe('ultra');
    expect(tierFromHints(desktop, false)).toBe('ultra');
  });

  it('honors explicit URL tier overrides', () => {
    expect(forcedTierFromSearch('?lowgfx')).toBe('low');
    expect(forcedTierFromSearch('?gfx=low')).toBe('low');
    expect(forcedTierFromSearch('?gfx=medium')).toBe('medium');
    expect(forcedTierFromSearch('?gfx=high')).toBe('high');
    expect(forcedTierFromSearch('?gfx=ultra')).toBe('ultra');
    expect(forcedTierFromSearch('?gfx=banana')).toBe(null);
  });

  it('treats phone-class and low-memory browsers as constrained', () => {
    expect(isConstrainedBrowser({ ...desktop, maxTouchPoints: 1, coarsePointer: true })).toBe(true);
    expect(isConstrainedBrowser({ ...desktop, maxTouchPoints: 1, narrowViewport: true })).toBe(
      true,
    );
    expect(isConstrainedBrowser({ ...desktop, deviceMemory: 4 })).toBe(true);
    expect(isConstrainedBrowser({ ...desktop, maxTouchPoints: 1 })).toBe(false);
    expect(isConstrainedBrowser(desktop)).toBe(false);
  });

  it('defaults missing presets to ultra while preserving legacy low and forced high', () => {
    expect(tierFromHints(desktop, false)).toBe('ultra');
    expect(tierFromHints({ ...desktop, graphicsPreset: 0 }, false)).toBe('low');
    expect(tierFromHints(desktop, true)).toBe('ultra');
    expect(tierFromHints({ ...desktop, maxTouchPoints: 1, coarsePointer: true }, false)).toBe(
      'ultra',
    );
    expect(
      tierFromHints(
        { ...desktop, search: '?gfx=high', maxTouchPoints: 1, coarsePointer: true },
        false,
      ),
    ).toBe('high');
    expect(tierFromHints({ ...desktop, search: '?gfx=ultra' }, true)).toBe('ultra');
  });

  it('honors persisted presets when the URL does not force a tier', () => {
    expect(tierFromHints({ ...desktop, graphicsPreset: 1 }, false)).toBe('low');
    expect(tierFromHints({ ...desktop, graphicsPreset: 2 }, false)).toBe('medium');
    expect(tierFromHints({ ...desktop, graphicsPreset: 3 }, false)).toBe('high');
    expect(tierFromHints({ ...desktop, graphicsPreset: 4 }, false)).toBe('ultra');
    expect(tierFromHints({ ...desktop, graphicsPreset: 5 }, false)).toBe('high');
    expect(tierFromHints({ ...desktop, search: '?gfx=low', graphicsPreset: 3 }, false)).toBe('low');
  });

  it('labels presets and runs the budget governor unless Ultra or URL-forced', () => {
    expect(graphicsPresetLabel(undefined)).toBe('ultra');
    expect(graphicsPresetLabel(0)).toBe('low');
    expect(graphicsPresetLabel(1)).toBe('low');
    expect(graphicsPresetLabel(2)).toBe('medium');
    expect(graphicsPresetLabel(3)).toBe('high');
    expect(graphicsPresetLabel(4)).toBe('ultra');
    expect(graphicsPresetLabel(5)).toBe('advanced');
    expect(shouldUseAutoGovernor({ search: '', graphicsPreset: 0 })).toBe(true);
    expect(shouldUseAutoGovernor({ search: '', graphicsPreset: undefined })).toBe(false);
    expect(shouldUseAutoGovernor({ search: '', graphicsPreset: 1 })).toBe(true);
    expect(shouldUseAutoGovernor({ search: '', graphicsPreset: 2 })).toBe(true);
    expect(shouldUseAutoGovernor({ search: '', graphicsPreset: 3 })).toBe(true);
    expect(shouldUseAutoGovernor({ search: '', graphicsPreset: 4 })).toBe(false);
    expect(shouldUseAutoGovernor({ search: '', graphicsPreset: 5 })).toBe(true);
    expect(shouldUseAutoGovernor({ search: '?gfx=low', graphicsPreset: 0 })).toBe(true);
    expect(shouldUseAutoGovernor({ search: '?gfx=high', graphicsPreset: 0 })).toBe(true);
    expect(shouldUseAutoGovernor({ search: '?gfx=ultra', graphicsPreset: 0 })).toBe(false);
    expect(shouldUseAutoGovernor({ search: '?gfx=ultra', graphicsPreset: 4 })).toBe(false);
    expect(shouldUseAutoGovernor({ search: '?governor=0', graphicsPreset: 1 })).toBe(false);
    expect(shouldUseAutoGovernor({ search: '?gfx=ultra&governor=1', graphicsPreset: 0 })).toBe(
      true,
    );
  });

  it('keeps every quality tier bounded by explicit runtime budgets', () => {
    for (const [tier, budget] of Object.entries(GFX_BUDGETS)) {
      expect(budget.targetFps).toBe(60);
      expect(budget.maxRenderScale).toBeLessThanOrEqual(1);
      expect(budget.minRenderScaleDesktop).toBeGreaterThanOrEqual(0.5);
      expect(budget.minRenderScaleMobile).toBeGreaterThanOrEqual(0.5);
      expect(budget.dropFrameMs).toBeLessThan(budget.urgentFrameMs);
      expect(budget.recoverFrameMs).toBeLessThan(budget.dropFrameMs);
      expect(tier).toMatch(/^(low|medium|high|ultra)$/);
    }
  });

  it('defines tunable bucket bands for every quality tier', () => {
    for (const [tier, bands] of Object.entries(GFX_BUCKET_BANDS)) {
      expect(Object.keys(bands).sort()).toEqual(
        [
          'characters',
          'foliage',
          'grass',
          'lighting',
          'materials',
          'props',
          'resolution',
          'ui',
          'vfx',
          'waterSky',
          'weapons',
          'worldStreaming',
        ].sort(),
      );
      for (const band of Object.values(bands)) {
        expect(band.min).toBeGreaterThanOrEqual(0);
        expect(band.max).toBeLessThanOrEqual(1);
        expect(band.min).toBeLessThanOrEqual(band.baseline);
        expect(band.baseline).toBeLessThanOrEqual(band.max);
      }
      expect(tier).toMatch(/^(low|medium|high|ultra)$/);
    }
    expect(GFX_BUCKET_BANDS.low.grass.baseline).toBeGreaterThan(GFX_BUCKET_BANDS.low.grass.min);
    expect(GFX_BUCKET_BANDS.low.foliage.baseline).toBeGreaterThan(GFX_BUCKET_BANDS.low.foliage.min);
    expect(GFX_BUCKET_BANDS.low.characters.baseline).toBe(1);
    expect(GFX_BUCKET_BANDS.low.weapons.baseline).toBe(1);
  });

  it('keeps medium as a middle tier while high and ultra retain the premium pipeline', () => {
    const low = gfxInternalsForTest.settingsFor('low');
    const medium = gfxInternalsForTest.settingsFor('medium');
    const mediumIris = gfxInternalsForTest.settingsFor('medium', {
      search: '?gfx=medium',
      gpuRenderer: 'ANGLE (Intel, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics 655)',
    });
    const high = gfxInternalsForTest.settingsFor('high');
    const ultra = gfxInternalsForTest.settingsFor('ultra');

    expect(low.standardMaterials).toBe(false);
    expect(low.leanFoliage).toBe(true);
    expect(low.lowPlus).toBe(true);
    expect(low.composer).toBe(false);
    expect(low.ao).toBe(false);

    expect(medium.standardMaterials).toBe(true);
    expect(medium.leanFoliage).toBe(false);
    expect(medium.lowPlus).toBe(false);
    expect(mediumIris.standardMaterials).toBe(true);
    expect(mediumIris.leanFoliage).toBe(true);
    expect(mediumIris.lowPlus).toBe(false);
    expect(medium.terrainSplat).toBe(true);
    expect(medium.composer).toBe(false);
    expect(medium.ao).toBe(false);
    expect(medium.shadowMap).toBeGreaterThan(low.shadowMap);
    expect(medium.shadowMap).toBeLessThan(high.shadowMap);
    expect(medium.pixelRatioCap).toBeLessThan(high.pixelRatioCap);

    expect(high.standardMaterials).toBe(true);
    expect(high.composer).toBe(true);
    expect(high.ao).toBe(true);
    expect(high.msaaSamples).toBe(4);
    expect(high.shadowMap).toBe(4096);

    expect(ultra.standardMaterials).toBe(true);
    expect(ultra.composer).toBe(true);
    expect(ultra.ao).toBe(true);
    expect(ultra.msaaSamples).toBe(4);
    expect(ultra.shadowMap).toBe(high.shadowMap);
    expect(ultra.pixelRatioCap).toBeGreaterThan(high.pixelRatioCap);
    expect(GFX_BUCKET_BANDS.ultra.grass.baseline).toBeGreaterThan(
      GFX_BUCKET_BANDS.high.grass.baseline,
    );
    expect(GFX_BUCKET_BANDS.ultra.foliage.baseline).toBeGreaterThan(
      GFX_BUCKET_BANDS.high.foliage.baseline,
    );
  });

  it('detects older Intel integrated GPUs without overriding the ultra default', () => {
    expect(
      isWeakIntegratedGpu(
        'ANGLE (Intel, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics 655)',
      ),
    ).toBe(true);
    expect(isWeakIntegratedGpu('ANGLE (Apple, ANGLE Metal Renderer: Apple M2)')).toBe(false);
    expect(
      tierFromHints(
        { ...desktop, gpuRenderer: 'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics 655)' },
        false,
      ),
    ).toBe('ultra');
  });

  it('classifies GPU renderer strings into device-capability buckets', () => {
    expect(classifyGpuRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080)')).toBe('strongDesktop');
    expect(classifyGpuRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M2)')).toBe(
      'strongDesktop',
    );
    expect(classifyGpuRenderer('Adreno (TM) 730')).toBe('flagshipMobile');
    expect(classifyGpuRenderer('Apple A17 Pro GPU')).toBe('flagshipMobile');
    expect(classifyGpuRenderer('Google SwiftShader')).toBe('software');
    // the codebase's named weak-integrated parts stay weak (checked before mid-integrated)
    expect(classifyGpuRenderer('ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics 655)')).toBe('weak');
    expect(classifyGpuRenderer('Adreno (TM) 330')).toBe('weak');
    expect(classifyGpuRenderer('PowerVR SGX 544')).toBe('weak');
    // newer integrated + mid mobile -> their own buckets (the MEDIUM path)
    expect(classifyGpuRenderer('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics)')).toBe(
      'midIntegrated',
    );
    expect(classifyGpuRenderer('Mali-G57')).toBe('midMobile');
    // masked / unplaced / empty -> unknown -> the MEDIUM fallback path
    expect(classifyGpuRenderer('Apple GPU')).toBe('unknown');
    expect(classifyGpuRenderer(undefined)).toBe('unknown');
    expect(classifyGpuRenderer('')).toBe('unknown');
  });

  describe('resolveDefaultGraphicsPreset: device-aware first-run default (medium fallback)', () => {
    // preset numbers: 1 low, 2 medium, 3 high, 4 ultra (never 5/advanced as an auto-default).
    const phone: GfxRuntimeHints = { ...desktop, maxTouchPoints: 5, coarsePointer: true };

    it('falls back to MEDIUM for a masked/unknown or mid GPU with no corroborating signal', () => {
      expect(resolveDefaultGraphicsPreset(desktop)).toBe(2); // no GPU/mem/cores -> medium
      expect(resolveDefaultGraphicsPreset({ ...desktop, gpuRenderer: 'Apple GPU' })).toBe(2); // masked
      expect(resolveDefaultGraphicsPreset({ ...desktop, gpuRenderer: 'Intel Iris Xe' })).toBe(2); // mid
    });

    it('drops a software or weak GPU to LOW (only the GPU class can low, never RAM/cores)', () => {
      expect(resolveDefaultGraphicsPreset({ ...desktop, gpuRenderer: 'Google SwiftShader' })).toBe(
        1,
      );
      expect(resolveDefaultGraphicsPreset({ ...desktop, gpuRenderer: 'Adreno (TM) 330' })).toBe(1);
      // PITFALL 1: a thin RAM/core count NEVER pulls a tier down (a flagship iPhone reports
      // cores=2 / mem=undefined); an unknown GPU with low mem+cores stays MEDIUM, not low.
      expect(resolveDefaultGraphicsPreset({ ...desktop, deviceMemory: 2 })).toBe(2);
      expect(
        resolveDefaultGraphicsPreset({ ...desktop, deviceMemory: 4, hardwareConcurrency: 2 }),
      ).toBe(2);
    });

    it('caps mobile at HIGH: flagship / strong-on-touch -> HIGH, weak phone -> LOW, else MEDIUM', () => {
      expect(
        resolveDefaultGraphicsPreset({ ...phone, gpuRenderer: 'Adreno (TM) 740', deviceMemory: 8 }),
      ).toBe(3); // flagship phone
      // an M-series iPad (strong GPU on a touch device) is capped at HIGH (ultra is desktop-only)
      expect(resolveDefaultGraphicsPreset({ ...phone, gpuRenderer: 'Apple M2' })).toBe(3);
      expect(resolveDefaultGraphicsPreset({ ...phone, gpuRenderer: 'Adreno (TM) 330' })).toBe(1); // old phone
      expect(resolveDefaultGraphicsPreset(phone)).toBe(2); // typical/unknown phone -> medium
    });

    it('rewards a strong desktop: ULTRA with a corroborating signal (or unreported mem), else HIGH', () => {
      const rtx = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080)';
      expect(
        resolveDefaultGraphicsPreset({
          ...desktop,
          gpuRenderer: rtx,
          deviceMemory: 8,
          hardwareConcurrency: 16,
        }),
      ).toBe(4);
      // mem unreported (Firefox) with a recognized strong GPU still earns ULTRA
      expect(resolveDefaultGraphicsPreset({ ...desktop, gpuRenderer: rtx })).toBe(4);
      // a strong GPU but a present, sub-threshold mem+cores -> HIGH (corroboration absent)
      expect(
        resolveDefaultGraphicsPreset({
          ...desktop,
          gpuRenderer: rtx,
          deviceMemory: 4,
          hardwareConcurrency: 4,
        }),
      ).toBe(3);
    });

    it('raises an unknown desktop GPU to HIGH only with ample RAM AND cores', () => {
      expect(
        resolveDefaultGraphicsPreset({ ...desktop, deviceMemory: 8, hardwareConcurrency: 12 }),
      ).toBe(3);
      // ample on only one axis is not enough for the unknown bucket -> MEDIUM
      expect(
        resolveDefaultGraphicsPreset({ ...desktop, deviceMemory: 8, hardwareConcurrency: 4 }),
      ).toBe(2);
    });

    it('a software/weak device lands on LOW, restoring the 1/15s nameplate cost ceiling', () => {
      // The whole point of the default: a weak device -> low preset -> the data-fx-level low
      // tier -> the restored nameplate staleness ceiling (the PR901 weak-GPU mitigation).
      const preset = resolveDefaultGraphicsPreset({
        ...desktop,
        gpuRenderer: 'Google SwiftShader',
      });
      expect(preset).toBe(1);
      const label = graphicsPresetLabel(preset);
      expect(label).toBe('low');
      expect(nameplateIntervalSec(label as 'low')).toBe(NAMEPLATE_INTERVAL_LOW_SEC);
    });
  });

  it('keeps masked double-sided vegetation off the transparent blended path', () => {
    const mat = configureMaskedDoubleSidedVegetationMaterial(
      new THREE.MeshBasicMaterial({
        alphaTest: 0.3,
        transparent: true,
      }),
    );

    expect(mat.alphaTest).toBe(0.3);
    expect(mat.side).toBe(THREE.DoubleSide);
    expect(mat.transparent).toBe(false);
    expect(mat.forceSinglePass).toBe(true);
    expect(mat.depthTest).toBe(true);
    expect(mat.depthWrite).toBe(true);
  });
});
