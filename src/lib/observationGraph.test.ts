import { describe, expect, it } from "vitest";
import {
  type ObsEdge,
  type ObsNode,
  initPositions,
  nodeColor,
  nodeRadius,
  relationColor,
  relationLabel,
  tickSimulation,
} from "./observationGraph";

const node = (id: string, degree = 0): ObsNode => ({
  id,
  path: `/memories/${id}.md`,
  summary: id,
  memory_type: "semantic",
  scope: "user",
  created_at: "2026-07-10T00:00:00Z",
  degree,
});

describe("initPositions", () => {
  it("returns one position per node with numeric x/y and zero velocity", () => {
    const positions = initPositions(
      [node("a"), node("b"), node("c")],
      800,
      600
    );
    expect(positions).toHaveLength(3);
    for (const p of positions) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.vx).toBe(0);
      expect(p.vy).toBe(0);
    }
    expect(new Set(positions.map((p) => p.id))).toEqual(
      new Set(["a", "b", "c"])
    );
  });

  it("handles the empty-node case without dividing by zero", () => {
    expect(initPositions([], 800, 600)).toEqual([]);
  });

  it("is deterministic across calls (stable jitter)", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const a = initPositions(nodes, 800, 600);
    const b = initPositions(nodes, 800, 600);
    expect(a).toEqual(b);
  });

  it("spreads nodes off the exact center by at least the jitter offset", () => {
    const [p] = initPositions([node("solo")], 800, 600);
    // Not exactly (400, 300) — the stable jitter offset pushes it off.
    expect(p.x === 400 && p.y === 300).toBe(false);
  });
});

describe("tickSimulation", () => {
  it("preserves position count and returns a non-negative energy", () => {
    const nodes = [node("a"), node("b")];
    const positions = initPositions(nodes, 400, 400);
    const edges: ObsEdge[] = [{ source: "a", target: "b", relation: "" }];
    const { positions: next, energy } = tickSimulation(
      positions,
      edges,
      400,
      400
    );
    expect(next).toHaveLength(positions.length);
    expect(energy).toBeGreaterThanOrEqual(0);
  });

  it("ignores edges pointing at unknown node ids", () => {
    const positions = initPositions([node("a")], 400, 400);
    const edges: ObsEdge[] = [
      { source: "a", target: "nope", relation: "" },
      { source: "nope", target: "a", relation: "" },
    ];
    expect(() => tickSimulation(positions, edges, 400, 400)).not.toThrow();
  });

  it("is deterministic given identical inputs", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const positions = initPositions(nodes, 400, 400);
    const edges: ObsEdge[] = [
      { source: "a", target: "b", relation: "" },
      { source: "b", target: "c", relation: "" },
    ];
    const r1 = tickSimulation(positions, edges, 400, 400);
    const r2 = tickSimulation(positions, edges, 400, 400);
    expect(r1.positions).toEqual(r2.positions);
    expect(r1.energy).toBe(r2.energy);
  });

  it("caps per-tick speed under the MAX_SPEED bound", () => {
    // Two nodes stacked on top of each other -> huge initial repulsion.
    // The speed clamp must keep post-tick velocity magnitude below 12.
    const positions = [
      { id: "a", x: 200, y: 200, vx: 0, vy: 0 },
      { id: "b", x: 200, y: 200, vx: 0, vy: 0 },
    ];
    const { positions: next } = tickSimulation(positions, [], 400, 400);
    for (const p of next) {
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      expect(speed).toBeLessThanOrEqual(12 + 1e-9);
    }
  });
});

describe("relationColor", () => {
  it("maps known relations to specific colors", () => {
    expect(relationColor("complements")).toBe("#10b981");
    expect(relationColor("contradicts")).toBe("#f43f5e");
    expect(relationColor("supersedes")).toBe("#f59e0b");
  });

  it("falls back to slate for unknown relations", () => {
    expect(relationColor("mystery")).toBe("#94a3b8");
    expect(relationColor("")).toBe("#94a3b8");
  });
});

describe("nodeRadius", () => {
  it("clamps below to 9 for tiny degree", () => {
    expect(nodeRadius(0)).toBe(9);
    expect(nodeRadius(-1)).toBe(9);
  });

  it("clamps above to 22 for large degree", () => {
    expect(nodeRadius(20)).toBe(22);
    expect(nodeRadius(100)).toBe(22);
  });

  it("scales linearly in the mid range", () => {
    expect(nodeRadius(2)).toBeCloseTo(14);
    expect(nodeRadius(4)).toBeCloseTo(19);
  });
});

describe("nodeColor", () => {
  it("colors procedural memories distinctively", () => {
    expect(nodeColor("procedural")).toBe("#0ea5e9");
  });

  it("falls back to indigo for other memory types", () => {
    expect(nodeColor("semantic")).toBe("#6366f1");
    expect(nodeColor("episodic")).toBe("#6366f1");
    expect(nodeColor("")).toBe("#6366f1");
  });
});

describe("relationLabel", () => {
  it("capitalizes known relations", () => {
    expect(relationLabel("complements")).toBe("Complements");
    expect(relationLabel("contradicts")).toBe("Contradicts");
    expect(relationLabel("supersedes")).toBe("Supersedes");
  });

  it("returns unknown relations verbatim", () => {
    expect(relationLabel("mystery")).toBe("mystery");
    expect(relationLabel("")).toBe("");
  });
});
