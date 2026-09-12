// ==========================================================================
// Regression tests for the structural-mechanics lab plugin.
//
// The plugin is normally driven by the browser rAF loop, so these tests stub
// rAF and step it by hand: this is the only way to catch "the sim silently
// refuses to (re)start" bugs, which look like a dead canvas in the UI.
// ==========================================================================

import { beforeEach, describe, expect, it } from 'vitest';
import createStructurePlugin from '@/plugins/builtin/structure';
import type { ContainerCapabilities, Plugin, PluginApi } from '@/types/plugin';

type AnyPlugin = Plugin & Record<string, any>;

let rafQueue: ((t: number) => void) | null = null;
let rafSeq = 0;

function make2dContext(): CanvasRenderingContext2D {
  const target: Record<string, unknown> = {
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    measureText: () => ({ width: 0 }),
    setLineDash: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray(0) }),
    save: () => {},
    restore: () => {},
  };
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k as string];
      return () => undefined;
    },
    set(t, k, v) {
      t[k as string] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const ctx = make2dContext();
  return {
    clientWidth: w,
    clientHeight: h,
    width: w,
    height: h,
    style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    addEventListener: () => {},
    removeEventListener: () => {},
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  } as unknown as HTMLCanvasElement;
}

function makeApi(): PluginApi {
  return {
    locale: 'zh-CN',
    notify: () => {},
    log: () => {},
    setStatus: () => {},
    reportDataScale: () => {},
    exportFile: () => {},
    openFile: async () => null,
    readText: async () => '',
    readBinary: async () => new ArrayBuffer(0),
    getParam: () => undefined,
    setParam: () => {},
    cache: {} as PluginApi['cache'],
  } as unknown as PluginApi;
}

/** Step the stubbed rAF loop forward by `seconds` at ~60 fps. */
function advance(seconds: number) {
  const frames = Math.round(seconds * 60);
  for (let i = 0; i < frames; i += 1) {
    const cb = rafQueue;
    rafQueue = null;
    if (!cb) return i;
    cb(performance.now() + (i + 1) * (1000 / 60));
  }
  return frames;
}

let plugin: AnyPlugin;

beforeEach(() => {
  rafQueue = null;
  rafSeq = 0;
  (globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => {
    rafQueue = cb;
    rafSeq += 1;
    return rafSeq;
  };
  (globalThis as any).cancelAnimationFrame = () => {
    rafQueue = null;
  };
  (globalThis as any).getComputedStyle = () => ({ backgroundColor: '' });
  (globalThis as any).performance ??= { now: () => Date.now() };

  plugin = createStructurePlugin() as AnyPlugin;
  plugin.init(makeApi());
  const container = {
    canvas2d: makeCanvas(800, 500),
    reportDataScale: () => {},
  } as unknown as ContainerCapabilities;
  plugin.activate!({ container, api: makeApi() });
  plugin.render!(container);
});

describe('structure plugin · simulation', () => {
  it('starts running with the seeded weight settled on the deck', () => {
    const weights = plugin.weights as { y: number }[];
    expect(weights.length).toBe(1);
    const y0 = weights[0]!.y;
    advance(1.2);
    // The seed settles its weight onto the deck (no drop impact): the weight
    // must stay supported — neither free-falling nor bouncing away.
    expect(Math.abs(weights[0]!.y - y0)).toBeLessThan(10);
    expect(plugin.state.running).toBe(true);
  });

  it('places a settled weight when the "drop" button is pressed', () => {
    advance(0.2);
    const before = (plugin.weights as unknown[]).length;
    plugin.updateParams!({ drop: { action: 'drop' } });
    const weights = plugin.weights as { y: number }[];
    expect(weights.length).toBe(before + 1);
    const dropped = weights[weights.length - 1]!;
    const y0 = dropped.y;
    advance(1.0);
    // "增加重物" settles the new weight onto the deck, so it must stay near
    // its placed position instead of falling through to the floor.
    expect(Math.abs(dropped.y - y0)).toBeLessThan(12);
  });

  it('resumes after the Run toggle is paused and pressed again', () => {
    advance(0.3);
    plugin.updateParams!({ run: false });
    expect(plugin.state.running).toBe(false);
    expect(rafQueue).toBe(null);

    plugin.updateParams!({ run: true });
    expect(plugin.state.running).toBe(true);
    // A resumed sim must re-arm the animation frame, otherwise the canvas is
    // frozen forever and the Run button looks dead.
    expect(rafQueue).not.toBe(null);
  });
});
