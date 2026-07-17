// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { loadThreadWorkflows, saveThreadWorkflows } from "./workflowStore";
import type { WorkflowDispatch, WorkflowMap } from "./dynamicWorkflow";

const STORAGE_KEY = "evoscientist-dynamic-workflows";

function dispatch(
  id: string,
  status: WorkflowDispatch["status"]
): WorkflowDispatch {
  return {
    id,
    label: `label ${id}`,
    subagentType: "task",
    description: "",
    status,
    startedAt: 0,
    durationMs: status === "running" ? undefined : 10,
  };
}

function mapWith(dispatches: WorkflowDispatch[]): WorkflowMap {
  return { call_1: { evalId: "call_1", dispatches, updatedAt: 1 } };
}

describe("workflowStore", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips terminal dispatches per thread", () => {
    saveThreadWorkflows(
      "t1",
      mapWith([dispatch("a", "done"), dispatch("b", "error")])
    );
    const loaded = loadThreadWorkflows("t1");
    expect(loaded["call_1"].dispatches.map((d) => d.id)).toEqual(["a", "b"]);
    expect(loadThreadWorkflows("t2")).toEqual({});
  });

  it("strips running rows and skips evals with no terminal row", () => {
    saveThreadWorkflows(
      "t1",
      mapWith([dispatch("a", "done"), dispatch("b", "running")])
    );
    expect(
      loadThreadWorkflows("t1")["call_1"].dispatches.map((d) => d.id)
    ).toEqual(["a"]);
    saveThreadWorkflows("t2", mapWith([dispatch("x", "running")]));
    expect(loadThreadWorkflows("t2")).toEqual({});
  });

  it("caps dispatches per eval at 200 keeping the newest", () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      dispatch(`d${i}`, "done")
    );
    saveThreadWorkflows("t1", mapWith(many));
    const rows = loadThreadWorkflows("t1")["call_1"].dispatches;
    expect(rows).toHaveLength(200);
    expect(rows[0].id).toBe("d50");
    expect(rows[199].id).toBe("d249");
  });

  it("evicts least-recently-updated threads beyond 20", () => {
    for (let i = 0; i < 21; i++) {
      saveThreadWorkflows(`t${i}`, mapWith([dispatch("a", "done")]));
    }
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) as string);
    expect(Object.keys(stored)).toHaveLength(20);
  });

  it("treats corrupt storage as empty", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadThreadWorkflows("t1")).toEqual({});
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ t1: { evals: { bad: 42 } } })
    );
    expect(loadThreadWorkflows("t1")).toEqual({});
  });

  it("rejects malformed dispatch fields before they can reach the UI", () => {
    const malformed = {
      evalId: "call_1",
      updatedAt: 1,
      dispatches: [
        {
          id: "bad",
          label: "bad",
          subagentType: "task",
          status: "not-a-real-status",
          startedAt: 0,
        },
      ],
    };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ t1: { updatedAt: 1, evals: { call_1: malformed } } })
    );
    expect(loadThreadWorkflows("t1")).toEqual({});
  });

  it("caps oversized data even when storage was written externally", () => {
    const oversized = mapWith(
      Array.from({ length: 250 }, (_, i) => dispatch(`external-${i}`, "done"))
    );
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ t1: { updatedAt: 1, evals: oversized } })
    );
    const rows = loadThreadWorkflows("t1")["call_1"].dispatches;
    expect(rows).toHaveLength(200);
    expect(rows[0].id).toBe("external-50");
  });

  it("evicts the least-recently-updated thread on tie, never the just-saved one", () => {
    for (let i = 0; i < 21; i++) {
      saveThreadWorkflows(`t${i}`, mapWith([dispatch("a", "done")]));
    }
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) as string);
    expect(Object.keys(stored)).toHaveLength(20);
    expect(stored["t20"]).toBeDefined();
    expect(stored["t0"]).toBeUndefined();
  });

  it("removes a thread entry when a save yields nothing persistable", () => {
    saveThreadWorkflows("t1", mapWith([dispatch("a", "done")]));
    expect(loadThreadWorkflows("t1")["call_1"]).toBeDefined();
    saveThreadWorkflows("t1", mapWith([dispatch("a", "running")]));
    expect(
      JSON.parse(localStorage.getItem(STORAGE_KEY) as string)["t1"]
    ).toBeUndefined();
  });
});
