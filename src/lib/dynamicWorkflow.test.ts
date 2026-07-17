import { describe, expect, it } from "vitest";
import {
  aggregateWorkflows,
  applySubagentEvent,
  finalizeRunning,
  formatWorkflowTiming,
  mergeWorkflowMaps,
  parseSubagentEvent,
  sanitizeLine,
  sortWorkflowEvals,
  workflowCounts,
  workflowElapsedMs,
  type SubagentEvent,
  type WorkflowMap,
} from "./dynamicWorkflow";

const startRaw = {
  type: "subagent",
  phase: "start",
  id: "ptc_task_aaaa1111",
  subagent_type: "general-purpose",
  label: "battle: idea-3 vs idea-7",
  description: "Run an ELO battle between idea 3 and idea 7",
  eval_id: "call_eval_1",
};

function apply(map: WorkflowMap, raw: unknown, now: number): WorkflowMap {
  const event = parseSubagentEvent(raw);
  expect(event).not.toBeNull();
  return applySubagentEvent(map, event as SubagentEvent, now);
}

describe("parseSubagentEvent", () => {
  it("parses a start event", () => {
    const event = parseSubagentEvent(startRaw);
    expect(event).toEqual({
      phase: "start",
      id: "ptc_task_aaaa1111",
      evalId: "call_eval_1",
      subagentType: "general-purpose",
      label: "battle: idea-3 vs idea-7",
      description: "Run an ELO battle between idea 3 and idea 7",
    });
  });

  it("defaults evalId to empty string when eval_id is absent", () => {
    const { eval_id: _omit, ...noEval } = startRaw;
    const event = parseSubagentEvent(noEval);
    expect(event?.evalId).toBe("");
  });

  it("falls back to compressed description when label is missing", () => {
    const event = parseSubagentEvent({
      ...startRaw,
      label: undefined,
      description: "  line one\nline\ttwo  ",
    });
    expect(event?.phase).toBe("start");
    if (event?.phase === "start") expect(event.label).toBe("line one line two");
  });

  it("rejects non-subagent, missing-id, and unknown-phase payloads", () => {
    expect(parseSubagentEvent(null)).toBeNull();
    expect(parseSubagentEvent({ type: "other" })).toBeNull();
    expect(parseSubagentEvent({ ...startRaw, id: "" })).toBeNull();
    expect(parseSubagentEvent({ ...startRaw, phase: "weird" })).toBeNull();
  });

  it("strips control and bidi characters from untrusted strings", () => {
    const event = parseSubagentEvent({
      ...startRaw,
      label: "evil‮ label here",
    });
    if (event?.phase === "start") expect(event.label).toBe("evil label here");
  });
});

describe("applySubagentEvent", () => {
  it("creates a running dispatch on start, grouped by evalId", () => {
    const map = apply({}, startRaw, 1000);
    const evalData = map["call_eval_1"];
    expect(evalData.dispatches).toHaveLength(1);
    expect(evalData.dispatches[0]).toMatchObject({
      id: "ptc_task_aaaa1111",
      status: "running",
      startedAt: 1000,
    });
  });

  it("marks done with durationMs on complete", () => {
    let map = apply({}, startRaw, 1000);
    map = apply(
      map,
      {
        type: "subagent",
        phase: "complete",
        id: "ptc_task_aaaa1111",
        duration_ms: 12345,
        eval_id: "call_eval_1",
      },
      13000
    );
    expect(map["call_eval_1"].dispatches[0]).toMatchObject({
      status: "done",
      durationMs: 12345,
    });
  });

  it("marks error with message on error", () => {
    let map = apply({}, startRaw, 1000);
    map = apply(
      map,
      {
        type: "subagent",
        phase: "error",
        id: "ptc_task_aaaa1111",
        duration_ms: 500,
        error: "boom",
        eval_id: "call_eval_1",
      },
      2000
    );
    expect(map["call_eval_1"].dispatches[0]).toMatchObject({
      status: "error",
      error: "boom",
    });
  });

  it("drops an orphan complete but adopts an orphan error", () => {
    const complete = apply(
      {},
      {
        type: "subagent",
        phase: "complete",
        id: "ghost",
        duration_ms: 5,
        eval_id: "e1",
      },
      1
    );
    expect(complete).toEqual({});
    const errored = apply(
      {},
      {
        type: "subagent",
        phase: "error",
        id: "ghost",
        duration_ms: 5,
        error: "lost start",
        eval_id: "e1",
      },
      1
    );
    expect(errored["e1"].dispatches[0]).toMatchObject({
      id: "ghost",
      status: "error",
      error: "lost start",
    });
  });

  it("is idempotent: terminal rows are never downgraded by replayed events", () => {
    let map = apply({}, startRaw, 1000);
    map = apply(
      map,
      {
        type: "subagent",
        phase: "complete",
        id: "ptc_task_aaaa1111",
        duration_ms: 100,
        eval_id: "call_eval_1",
      },
      1100
    );
    const replayedStart = apply(map, startRaw, 1200);
    expect(replayedStart).toBe(map);
    const replayedComplete = apply(
      map,
      {
        type: "subagent",
        phase: "complete",
        id: "ptc_task_aaaa1111",
        duration_ms: 999,
        eval_id: "call_eval_1",
      },
      1300
    );
    expect(replayedComplete).toBe(map);
  });

  it("keeps arrival order across mixed dispatches", () => {
    let map = apply({}, startRaw, 1);
    map = apply(
      map,
      { ...startRaw, id: "ptc_task_bbbb2222", label: "second" },
      2
    );
    expect(map["call_eval_1"].dispatches.map((d) => d.id)).toEqual([
      "ptc_task_aaaa1111",
      "ptc_task_bbbb2222",
    ]);
  });
});

describe("finalizeRunning", () => {
  it("cancels running rows, freezes duration, and returns same ref when nothing runs", () => {
    const map = apply({}, startRaw, 1000);
    const finalized = finalizeRunning(map, 4000);
    expect(finalized["call_eval_1"].dispatches[0]).toMatchObject({
      status: "cancelled",
      durationMs: 3000,
    });
    expect(finalizeRunning(finalized, 5000)).toBe(finalized);
  });
});

describe("mergeWorkflowMaps", () => {
  it("prefers terminal rows and appends live-only dispatches", () => {
    const stored = apply(
      apply({}, startRaw, 1),
      {
        type: "subagent",
        phase: "complete",
        id: "ptc_task_aaaa1111",
        duration_ms: 10,
        eval_id: "call_eval_1",
      },
      2
    );
    const live = apply(
      apply({}, startRaw, 5),
      { ...startRaw, id: "ptc_task_cccc3333", label: "live only" },
      6
    );
    const merged = mergeWorkflowMaps(stored, live);
    const rows = merged["call_eval_1"].dispatches;
    expect(rows.map((d) => d.id)).toEqual([
      "ptc_task_aaaa1111",
      "ptc_task_cccc3333",
    ]);
    expect(rows[0].status).toBe("done");
    expect(rows[1].status).toBe("running");
  });
});

describe("counts and timing", () => {
  it("counts statuses and formats stable-width timing", () => {
    let map = apply({}, startRaw, 0);
    map = apply(map, { ...startRaw, id: "d2" }, 0);
    map = apply(map, { ...startRaw, id: "d3" }, 0);
    map = apply(
      map,
      {
        type: "subagent",
        phase: "complete",
        id: "d2",
        duration_ms: 2000,
        eval_id: "call_eval_1",
      },
      2000
    );
    map = apply(
      map,
      {
        type: "subagent",
        phase: "error",
        id: "d3",
        duration_ms: 3000,
        error: "x",
        eval_id: "call_eval_1",
      },
      3000
    );
    expect(workflowCounts(map["call_eval_1"])).toEqual({
      total: 3,
      finished: 2,
      failed: 1,
      cancelled: 0,
      running: 1,
    });
    expect(workflowElapsedMs(map["call_eval_1"], 10000)).toBe(10000);
    expect(formatWorkflowTiming(4000)).toBe("4.0s");
    expect(formatWorkflowTiming(4230)).toBe("4.2s");
    expect(formatWorkflowTiming(95000)).toBe("1m 35s");
  });

  it("freezes workflow elapsed at last finish once all rows are terminal", () => {
    let map = apply({}, startRaw, 0);
    map = apply(
      map,
      {
        type: "subagent",
        phase: "complete",
        id: "ptc_task_aaaa1111",
        duration_ms: 7000,
        eval_id: "call_eval_1",
      },
      7000
    );
    expect(workflowElapsedMs(map["call_eval_1"], 99999)).toBe(7000);
  });
});

describe("sanitizeLine", () => {
  it("flattens newlines, strips controls, and bounds length", () => {
    expect(sanitizeLine("a\nb", 10)).toBe("a b");
    expect(sanitizeLine("x".repeat(300), 10)).toHaveLength(10);
  });
});

describe("aggregateWorkflows and sortWorkflowEvals", () => {
  const doneDispatch = {
    id: "d1",
    label: "battle one",
    subagentType: "task",
    description: "",
    status: "done" as const,
    startedAt: 100,
    durationMs: 500,
  };
  const runningDispatch = {
    id: "d2",
    label: "refine two",
    subagentType: "task",
    description: "",
    status: "running" as const,
    startedAt: 2000,
  };
  const cancelledDispatch = {
    id: "d3",
    label: "old three",
    subagentType: "task",
    description: "",
    status: "cancelled" as const,
    startedAt: 50,
    durationMs: 10,
  };

  it("aggregates counts, running label, and active eval across evals", () => {
    const map: WorkflowMap = {
      call_a: {
        evalId: "call_a",
        dispatches: [doneDispatch, cancelledDispatch],
        updatedAt: 500,
      },
      call_b: {
        evalId: "call_b",
        dispatches: [runningDispatch],
        updatedAt: 2000,
      },
      call_empty: { evalId: "call_empty", dispatches: [], updatedAt: 9999 },
    };
    expect(aggregateWorkflows(map)).toEqual({
      phaseCount: 2,
      total: 3,
      finished: 2,
      failed: 0,
      cancelled: 1,
      running: 1,
      runningLabel: "refine two",
      activeEvalId: "call_b",
    });
  });

  it("falls back to the newest eval when nothing runs", () => {
    const map: WorkflowMap = {
      call_a: { evalId: "call_a", dispatches: [doneDispatch], updatedAt: 500 },
      call_b: {
        evalId: "call_b",
        dispatches: [cancelledDispatch],
        updatedAt: 800,
      },
    };
    const agg = aggregateWorkflows(map);
    expect(agg.running).toBe(0);
    expect(agg.runningLabel).toBeNull();
    expect(agg.activeEvalId).toBe("call_b");
  });

  it("returns an empty aggregate for an empty map", () => {
    expect(aggregateWorkflows({})).toEqual({
      phaseCount: 0,
      total: 0,
      finished: 0,
      failed: 0,
      cancelled: 0,
      running: 0,
      runningLabel: null,
      activeEvalId: null,
    });
  });

  it("sorts evals by earliest dispatch start and skips empty evals", () => {
    const map: WorkflowMap = {
      late: { evalId: "late", dispatches: [runningDispatch], updatedAt: 1 },
      early: {
        evalId: "early",
        dispatches: [cancelledDispatch, doneDispatch],
        updatedAt: 2,
      },
      empty: { evalId: "empty", dispatches: [], updatedAt: 3 },
    };
    expect(sortWorkflowEvals(map).map((e) => e.evalId)).toEqual([
      "early",
      "late",
    ]);
  });
});
