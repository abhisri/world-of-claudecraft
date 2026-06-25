// PainterHost: the thin shared host that HUD windows and painters compose into.
//
// Factored into TWO facets (frontend-modernization v0.16.0, locked decision 8),
// because the already-tested bespoke windows do NOT share one dep shape:
//
//   1) PainterHostPresentation -- the icon / money / tooltip surface. This is the
//      shared BASE the cold windows COMPOSE into where they actually render item
//      rows (today only the vendor window does; lockpick is callback-driven and
//      raid_lockout is a pure HTML-string builder, so neither composes it). It is
//      a presentation dep-bag, NOT a unified bag the windows migrate onto: a
//      window's own deps interface EXTENDS this and keeps its window-specific
//      members on top.
//
//   2) PainterHostWriters -- the write-elision facet: the four cached DOM writers
//      Hud already uses on its per-frame path (setText/setDisplay/setTransform/
//      setWidth at hud.ts), exposed to painters as closures over Hud's shared
//      hotWriteCache via makeWriterFacet. Hud keeps its own four private writer
//      methods unchanged (no visibility change) AND builds an equivalent facet to
//      hand to painters; both share the SAME cache, so the skip-rate stays one
//      number. The per-frame phases (P10-P13) consume this facet; P10a EXTENDS it
//      with setStyleProp/toggleClass (locked decision 5a) that the four existing
//      writers cannot express. This phase binds only the four that exist.
//
// This module is host-agnostic and Node-importable: it touches no `window` /
// `document` global. The writer closures write element properties (`el.textContent`
// / `el.style.*`) on elements handed to them, but never reach for a browser global,
// so the host itself imports cleanly under Vitest.

import type { ItemDef } from '../sim/types';

/**
 * Facet 1: the presentation dep-bag. Exactly the icon / money / tooltip helpers a
 * window needs to paint item rows via `innerHTML`. A window's deps interface
 * composes this (extends it) and adds its own members; Hud builds one bag and
 * hands it to every window that renders items, so the helpers live in one place.
 */
export interface PainterHostPresentation {
  /** `<img>` markup for an item's procedural icon. */
  itemIcon(item: ItemDef): string;
  /** Localized coin markup (gold/silver/copper) for a copper amount. */
  moneyHtml(copper: number): string;
  /** Full item tooltip markup (name, stats, compare). */
  itemTooltip(item: ItemDef): string;
  /** Attach a lazily-built tooltip to an element. */
  attachTooltip(el: HTMLElement, html: () => string): void;
}

/**
 * Facet 2: the write-elision facet. The four cached DOM writers, each eliding a
 * repeat write of an identical value to the same element (one cached string per
 * element). A painter routes its DOM text/display/transform/width writes through
 * these so a no-op frame costs no DOM mutation. The CANVAS schematic a 2D painter
 * draws is NOT routed through here: a 2D context cannot be elided (locked
 * decision 12), so a Canvas painter touches the context directly and uses these
 * writers only for the DOM bits it owns (e.g. a `#zone-label` text node).
 */
export interface PainterHostWriters {
  /** Set `el.textContent`, eliding a repeat of the same text. */
  setText(el: HTMLElement, text: string): void;
  /** Set `el.style.display`, eliding a repeat of the same value. */
  setDisplay(el: HTMLElement, display: string): void;
  /** Set `el.style.transform`, eliding a repeat of the same value. */
  setTransform(el: HTMLElement, transform: string): void;
  /** Set `el.style.width`, eliding a repeat of the same value. */
  setWidth(el: HTMLElement, width: string): void;
}

/**
 * Build the write-elision facet over a supplied cache. The four returned closures
 * share `cache` (one string per element) and report each real write via `onWrite`
 * and each elided write via `onSkip`, so a host that builds the facet from its own
 * cache + counters keeps a single skip-rate across its direct writes and the
 * painter writes. The key scheme matches Hud's private writers exactly (raw text
 * for setText; `display:`/`transform:`/`width:` prefixes for the style writers) so
 * the two never disagree on the same element.
 */
export function makeWriterFacet(
  cache: Map<HTMLElement, string>,
  onWrite: () => void,
  onSkip: () => void,
): PainterHostWriters {
  const write = (el: HTMLElement, key: string, apply: () => void): void => {
    if (cache.get(el) === key) {
      onSkip();
      return;
    }
    cache.set(el, key);
    onWrite();
    apply();
  };
  return {
    setText: (el, text) =>
      write(el, text, () => {
        el.textContent = text;
      }),
    setDisplay: (el, display) =>
      write(el, `display:${display}`, () => {
        el.style.display = display;
      }),
    setTransform: (el, transform) =>
      write(el, `transform:${transform}`, () => {
        el.style.transform = transform;
      }),
    setWidth: (el, width) =>
      write(el, `width:${width}`, () => {
        el.style.width = width;
      }),
  };
}
