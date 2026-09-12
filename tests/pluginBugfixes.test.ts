// Regressions for the reported plugin defects:
//   1. Protein: the Proteins slider could not be filled — its fixed ceiling
//      let the request run past the end of the loaded network.
//   2. N-body: the interactive loop integrated only a prefix of the drawn
//      set, freezing every body past the cap on screen.
//   3. LBM fluid: the outflow reflected pressure waves, the impulsive start
//      launched a domain-crossing shock, and a diverged run never recovered.
//   4. Every Start/Stop toggle needed two clicks, and importing data left a
//      running simulation running.
//   5. Structure: entering the plugin (and loading a truss) started the
//      simulation outright instead of waiting for ▶ Run.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import {
  FLUID_DIRECTIONS,
  fluidCollideKernelWGSL,
  fluidMacroCPU,
  fluidStepCPU,
} from '@/core/wgsl';
import { ProteinPlugin } from '@/plugins/builtin/protein';
import { NBodyPlugin } from '@/plugins/builtin/nbody';
import { FluidPlugin } from '@/plugins/builtin/fluid';
import { ParticlePlugin } from '@/plugins/builtin/particles';
import { WavePlugin } from '@/plugins/builtin/wave';
import { DoublePendulumPlugin } from '@/plugins/builtin/doublePendulum';
import { StructurePlugin } from '@/plugins/builtin/structure';
import type { NBodyBody } from '@/core/wgsl';
import type { ContainerCapabilities, ParamDefinition, PluginApi } from '@/types/plugin';

// The animation loops schedule frames; node has no rAF.
beforeAll(() => {
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 1;
  (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = () => undefined;
});

function fakeApi(): PluginApi {
  return {
    locale: 'en-US',
    t: (k: string) => k,
    onLocaleChange: () => () => {},
    setStatus: () => {},
    reportGpuTime: () => {},
    reportDataScale: () => {},
    notify: () => {},
    log: () => {},
    exportFile: () => {},
    cache: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => false,
      clear: async () => {},
      keys: async () => [],
    },
    openFile: async () => null,
    readText: async () => '',
    readBinary: async () => new ArrayBuffer(0),
    getParam: () => undefined,
    setParam: () => {},
  };
}

function rangeParam(defs: ParamDefinition[], key: string) {
  const def = defs.find((d) => d.key === key);
  if (!def || def.type !== 'range') throw new Error(`${key} is not a range param`);
  return def;
}

function toggleValue(defs: ParamDefinition[], key: string): boolean {
  const def = defs.find((d) => d.key === key);
  if (!def || def.type !== 'toggle') throw new Error(`${key} is not a toggle param`);
  return Boolean(def.value);
}

// ---- Proteins slider ------------------------------------------------------

describe('protein count slider', () => {
  function network(n: number) {
    const proteins = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `p${i}` }));
    return new File([JSON.stringify({ proteins, interactions: [] })], 'protein.json');
  }

  it('reports a ceiling that matches the loaded network', async () => {
    const plugin = new ProteinPlugin();
    await plugin.init(fakeApi());
    // Before any import the full design ceiling is offered.
    expect(rangeParam(plugin.getParams(), 'count').max).toBe(2000);

    await plugin.loadData(network(560));
    const slider = rangeParam(plugin.getParams(), 'count');
    expect(slider.max).toBe(560);
    expect(slider.value).toBe(560);
  });

  it('keeps the requested count instead of snapping back to the loaded size', async () => {
    const plugin = new ProteinPlugin();
    await plugin.init(fakeApi());
    await plugin.loadData(network(560));

    plugin.updateParams({ count: 300 });
    const p = plugin as unknown as { nodes: unknown[]; state: { count: number } };
    expect(p.nodes).toHaveLength(300);
    // The old bug: resampleTo() overwrote state.count with the loaded size,
    // so the thumb jumped back and the slider could never be filled.
    expect(p.state.count).toBe(300);
    expect(rangeParam(plugin.getParams(), 'count').value).toBe(300);
  });
});

// ---- N-body interactive loop ----------------------------------------------

describe('nbody interactive integration', () => {
  it('caps the set once at start instead of freezing the tail every frame', async () => {
    const plugin = new NBodyPlugin();
    await plugin.init(fakeApi());
    const bodies = Array.from({ length: 6000 }, (_, i) => ({
      x: Math.cos(i) * 2,
      y: Math.sin(i) * 2,
      z: i * 0.001,
      vx: 0,
      vy: 0,
      vz: 0,
      mass: 1,
    }));
    await plugin.loadData(new File([JSON.stringify({ bodies })], 'nbody.json'));

    const p = plugin as unknown as { bodies: NBodyBody[]; state: { count: number } };
    // The slider ceiling follows the dataset, not the hard MAX_BODIES.
    expect(rangeParam(plugin.getParams(), 'count').max).toBeGreaterThanOrEqual(6000);
    expect(p.bodies).toHaveLength(6000);

    // Starting the run downsamples to what the loop can integrate, so no
    // body is left motionless on screen.
    plugin.updateParams({ start: true });
    expect(p.bodies).toHaveLength(4096);
    expect(p.state.count).toBe(4096);

    // One frame must move *every* drawn body — the old prefix sweep left
    // bodies past the cap pinned at their initial position.
    const before = p.bodies.map((b) => ({ x: b.x, y: b.y, z: b.z }));
    (plugin as unknown as { tick: () => void }).tick();
    let moved = 0;
    for (let i = 0; i < p.bodies.length; i += 1) {
      const b = p.bodies[i] as NBodyBody;
      const a = before[i]!;
      if (b.x !== a.x || b.y !== a.y || b.z !== a.z) moved += 1;
    }
    expect(moved).toBe(p.bodies.length);
    plugin.updateParams({ start: false });
  });
});

// ---- LBM outflow / stability ----------------------------------------------

describe('fluid outflow absorbing layer', () => {
  it('is present in the WGSL collide kernel', () => {
    expect(fluidCollideKernelWGSL()).toContain('spongeStrength');
  });

  it('establishes a steady outflow instead of ringing', () => {
    // Long channel, obstacle in the upstream third. Without the absorbing
    // layer the startup transient sloshes between the fixed-density inlet
    // and the copy-outflow and the density keeps ringing forever.
    const W = 96;
    const H = 24;
    const cells = W * H;
    const f = new Float32Array(cells * FLUID_DIRECTIONS);
    const fpost = new Float32Array(f.length);
    const flags = new Float32Array(cells);
    for (let y = 10; y < 14; y += 1) for (let x = 16; x < 22; x += 1) flags[y * W + x] = 1;
    // Seed at rest (what the plugin now does) and ramp the inflow in.
    for (let cell = 0; cell < cells; cell += 1) {
      for (let d = 0; d < FLUID_DIRECTIONS; d += 1) {
        const w = d === 0 ? 4 / 9 : d <= 4 ? 1 / 9 : 1 / 36;
        f[cell * FLUID_DIRECTIONS + d] = w;
      }
    }
    for (let s = 0; s < 1200; s += 1) {
      const t = Math.min(1, s / 300);
      const u0 = 0.1 * t * t * (3 - 2 * t);
      fluidStepCPU(f, fpost, flags, W, H, 1.8, u0);
    }

    const { rho, ux } = fluidMacroCPU(f, W, H);
    for (let y = 2; y < H - 2; y += 1) {
      // Downstream end: pinned to the free stream, so nothing accumulates
      // there and nothing comes back upstream.
      const out = y * W + (W - 2);
      expect(Number.isFinite(rho[out]!)).toBe(true);
      expect(Math.abs(rho[out]! - 1)).toBeLessThan(0.15);
      expect(ux[out]!).toBeGreaterThan(0.02);
      // Upstream end: no global density drift from a trapped wave.
      const inl = y * W + 2;
      expect(Math.abs(rho[inl]! - 1)).toBeLessThan(0.15);
    }
  });
});

describe('fluid divergence recovery', () => {
  it('detects a blown-up lattice and reseeds instead of rendering NaN', async () => {
    const plugin = new FluidPlugin();
    const notify = vi.fn();
    await plugin.init({ ...fakeApi(), notify });
    const values = Array.from({ length: 32 }, () => new Array<number>(48).fill(0));
    for (let y = 12; y < 20; y += 1) for (let x = 18; x < 30; x += 1) values[y]![x] = 1;
    await plugin.loadData(new File([JSON.stringify({ values })], 'mask.json'));

    const p = plugin as unknown as {
      f: Float32Array;
      cols: number;
      rows: number;
      diverged: boolean;
      state: { running: boolean };
      hasDiverged: (rho: Float32Array, ux: Float32Array, uy: Float32Array) => boolean;
      recoverFromDivergence: () => void;
    };
    // A healthy, freshly seeded lattice is not flagged (solid cells hold zero
    // populations and must not trip the density check).
    const healthy = fluidMacroCPU(p.f, p.cols, p.rows);
    expect(p.hasDiverged(healthy.rho, healthy.ux, healthy.uy)).toBe(false);

    // Corrupt the field the way a diverged run does.
    p.f.fill(Number.NaN);
    const macro = fluidMacroCPU(p.f, p.cols, p.rows);
    expect(p.hasDiverged(macro.rho, macro.ux, macro.uy)).toBe(true);

    p.state.running = true;
    p.recoverFromDivergence();
    expect(notify).toHaveBeenCalled();
    expect(p.diverged).toBe(true);
    // Recovery reseeds: the field is finite again and the run is stopped.
    expect(Number.isFinite(p.f[0]!)).toBe(true);
    expect(p.state.running).toBe(false);
  });
});

// ---- importing data must halt the run -------------------------------------

describe('loading data stops the simulation', () => {
  // Every animated builtin shares the same contract: importing new data ends
  // the run, and the user restarts it explicitly through the Start toggle.
  // Without it a still-running frame loop advanced the freshly loaded state
  // the instant it was applied.
  const fluidMask = () =>
    new File(
      [
        JSON.stringify({
          values: Array.from({ length: 32 }, () => new Array<number>(48).fill(0)).map(
            (row, y) => row.map((_, x) => (y >= 12 && y < 20 && x >= 18 && x < 30 ? 1 : 0)),
          ),
        }),
      ],
      'mask.json',
    );

  const proteinNet = () =>
    new File(
      [
        JSON.stringify({
          proteins: Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, name: `p${i}` })),
          interactions: [],
        }),
      ],
      'protein.json',
    );

  const nbodySet = () =>
    new File(
      [
        JSON.stringify({
          bodies: Array.from({ length: 120 }, (_, i) => ({
            x: Math.cos(i),
            y: Math.sin(i),
            z: 0,
            vx: 0,
            vy: 0,
            vz: 0,
            mass: 1,
          })),
        }),
      ],
      'nbody.json',
    );

  const particlesDat = () =>
    new File(['0 0 1 1\n1 1 2 2\n2 2 3 3\n'], 'particles.dat');

  const waveField = () =>
    new File(
      [
        JSON.stringify({
          u: Array.from({ length: 24 }, () => new Array<number>(32).fill(0)),
        }),
      ],
      'wave.json',
    );

  const pendulumIC = () => new File([JSON.stringify({ th1: 30, th2: 60 })], 'ic.json');

  it('fluid', async () => {
    const plugin = new FluidPlugin();
    await plugin.init(fakeApi());
    await plugin.loadData(fluidMask());
    plugin.updateParams({ start: true });
    expect(toggleValue(plugin.getParams(), 'start')).toBe(true);

    await plugin.loadData(fluidMask());
    expect(toggleValue(plugin.getParams(), 'start')).toBe(false);
    // …and the user can still start again afterwards.
    plugin.updateParams({ start: true });
    expect(toggleValue(plugin.getParams(), 'start')).toBe(true);
    plugin.updateParams({ start: false });
  });

  it('protein', async () => {
    const plugin = new ProteinPlugin();
    await plugin.init(fakeApi());
    await plugin.loadData(proteinNet());
    plugin.updateParams({ start: true });
    expect(toggleValue(plugin.getParams(), 'start')).toBe(true);

    await plugin.loadData(proteinNet());
    expect(toggleValue(plugin.getParams(), 'start')).toBe(false);
  });

  it('nbody', async () => {
    const plugin = new NBodyPlugin();
    await plugin.init(fakeApi());
    await plugin.loadData(nbodySet());
    plugin.updateParams({ start: true });
    expect(toggleValue(plugin.getParams(), 'start')).toBe(true);

    await plugin.loadData(nbodySet());
    expect(toggleValue(plugin.getParams(), 'start')).toBe(false);
  });

  it('particles', async () => {
    const plugin = new ParticlePlugin();
    await plugin.init(fakeApi());
    await plugin.loadData(particlesDat());
    plugin.updateParams({ start: true });
    expect(toggleValue(plugin.getParams(), 'start')).toBe(true);

    await plugin.loadData(particlesDat());
    expect(toggleValue(plugin.getParams(), 'start')).toBe(false);
  });

  it('wave', async () => {
    const plugin = new WavePlugin();
    await plugin.init(fakeApi());
    await plugin.loadData(waveField());
    plugin.updateParams({ start: true });
    expect(toggleValue(plugin.getParams(), 'start')).toBe(true);

    await plugin.loadData(waveField());
    expect(toggleValue(plugin.getParams(), 'start')).toBe(false);
  });

  it('double pendulum', async () => {
    const plugin = new DoublePendulumPlugin();
    await plugin.init(fakeApi());
    await plugin.loadData(pendulumIC());
    plugin.updateParams({ start: true });
    expect(toggleValue(plugin.getParams(), 'start')).toBe(true);

    await plugin.loadData(pendulumIC());
    expect(toggleValue(plugin.getParams(), 'start')).toBe(false);
  });
});

// ---- entering a plugin must not start it ---------------------------------

describe('structure plugin opens paused', () => {
  const truss = () =>
    new File(
      [
        JSON.stringify({
          nodes: [
            { x: 0, y: 0.5 },
            { x: 0.5, y: 0.5 },
            { x: 1, y: 0.5 },
          ],
          members: [
            { a: 0, b: 1 },
            { a: 1, b: 2 },
          ],
        }),
      ],
      'truss.json',
    );

  it('opens empty, refuses ▶ Run without data, and requires ▶ Run once loaded', async () => {
    const plugin = new StructurePlugin();
    await plugin.init(fakeApi());
    await plugin.activate({
      container: { canvas2d: null } as unknown as ContainerCapabilities,
    });

    // The plugin must not fabricate a truss on open — and with nothing staged
    // it must refuse to run instead of "running" an empty bench.
    expect((plugin as any).joints.length).toBe(0);
    expect(toggleValue(plugin.getParams(), 'run')).toBe(false);
    plugin.updateParams({ run: true });
    expect(toggleValue(plugin.getParams(), 'run')).toBe(false);

    // The run toggle is the only way in once a structure is loaded.
    await plugin.loadData(truss());
    expect(toggleValue(plugin.getParams(), 'run')).toBe(false);

    plugin.updateParams({ run: true });
    expect(toggleValue(plugin.getParams(), 'run')).toBe(true);

    // Loading a structure halts the run and stages the new one paused.
    await plugin.loadData(truss());
    expect(toggleValue(plugin.getParams(), 'run')).toBe(false);

    // …and it can still be started again afterwards.
    plugin.updateParams({ run: true });
    expect(toggleValue(plugin.getParams(), 'run')).toBe(true);
    plugin.updateParams({ run: false });
  });
});
