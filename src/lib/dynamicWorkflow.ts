export type DispatchStatus = "running" | "done" | "error" | "cancelled";

export interface WorkflowDispatch {
  id: string;
  label: string;
  subagentType: string;
  description: string;
  status: DispatchStatus;
  startedAt: number;
  durationMs?: number;
  error?: string;
}

export interface WorkflowEval {
  evalId: string;
  dispatches: WorkflowDispatch[];
  updatedAt: number;
}

export type WorkflowMap = Record<string, WorkflowEval>;

export type SubagentEvent =
  | {
      phase: "start";
      id: string;
      evalId: string;
      subagentType: string;
      label: string;
      description: string;
    }
  | { phase: "complete"; id: string; evalId: string; durationMs: number }
  | {
      phase: "error";
      id: string;
      evalId: string;
      durationMs: number;
      error: string;
    };

const CONTROL_AND_BIDI = /[\p{Cc}\p{Bidi_Control}]/gu;

export const ROW_ERROR_MAX_CHARS = 120;
const LABEL_MAX_CHARS = 200;
const TYPE_MAX_CHARS = 60;
const LABEL_FALLBACK_MAX_CHARS = 60;
const STORED_ERROR_MAX_CHARS = 2000;

export function sanitizeLine(text: string, maxChars: number): string {
  return text
    .replace(CONTROL_AND_BIDI, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function isTerminal(status: DispatchStatus): boolean {
  return status !== "running";
}

export function parseSubagentEvent(data: unknown): SubagentEvent | null {
  if (!data || typeof data !== "object") return null;
  const raw = data as Record<string, unknown>;
  if (raw.type !== "subagent") return null;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  const id = raw.id;
  const evalId = typeof raw.eval_id === "string" ? raw.eval_id : "";
  const durationMs =
    typeof raw.duration_ms === "number" && Number.isFinite(raw.duration_ms)
      ? Math.max(0, Math.round(raw.duration_ms))
      : 0;
  if (raw.phase === "start") {
    const description =
      typeof raw.description === "string"
        ? sanitizeLine(raw.description, LABEL_MAX_CHARS)
        : "";
    const explicitLabel =
      typeof raw.label === "string"
        ? sanitizeLine(raw.label, LABEL_MAX_CHARS)
        : "";
    return {
      phase: "start",
      id,
      evalId,
      subagentType:
        typeof raw.subagent_type === "string" && raw.subagent_type
          ? sanitizeLine(raw.subagent_type, TYPE_MAX_CHARS)
          : "subagent",
      label:
        explicitLabel || description.slice(0, LABEL_FALLBACK_MAX_CHARS) || id,
      description,
    };
  }
  if (raw.phase === "complete") {
    return { phase: "complete", id, evalId, durationMs };
  }
  if (raw.phase === "error") {
    return {
      phase: "error",
      id,
      evalId,
      durationMs,
      error:
        typeof raw.error === "string"
          ? sanitizeLine(raw.error, STORED_ERROR_MAX_CHARS)
          : "",
    };
  }
  return null;
}

function findDispatch(
  map: WorkflowMap,
  id: string
): { evalKey: string; index: number } | null {
  for (const [evalKey, evalData] of Object.entries(map)) {
    const index = evalData.dispatches.findIndex((d) => d.id === id);
    if (index !== -1) return { evalKey, index };
  }
  return null;
}

function withEval(
  map: WorkflowMap,
  evalKey: string,
  now: number,
  dispatches: WorkflowDispatch[]
): WorkflowMap {
  const existing = map[evalKey];
  return {
    ...map,
    [evalKey]: {
      evalId: existing?.evalId ?? evalKey,
      dispatches,
      updatedAt: now,
    },
  };
}

export function applySubagentEvent(
  map: WorkflowMap,
  event: SubagentEvent,
  now: number
): WorkflowMap {
  const located = findDispatch(map, event.id);
  if (event.phase === "start") {
    if (located) {
      const evalData = map[located.evalKey];
      const existing = evalData.dispatches[located.index];
      if (isTerminal(existing.status)) return map;
      const dispatches = [...evalData.dispatches];
      dispatches[located.index] = {
        ...existing,
        label: event.label,
        subagentType: event.subagentType,
        description: event.description,
      };
      return withEval(map, located.evalKey, now, dispatches);
    }
    const evalData = map[event.evalId];
    const dispatch: WorkflowDispatch = {
      id: event.id,
      label: event.label,
      subagentType: event.subagentType,
      description: event.description,
      status: "running",
      startedAt: now,
    };
    return withEval(map, event.evalId, now, [
      ...(evalData?.dispatches ?? []),
      dispatch,
    ]);
  }
  if (!located) {
    if (event.phase === "complete") return map;
    const evalData = map[event.evalId];
    const orphan: WorkflowDispatch = {
      id: event.id,
      label: event.id,
      subagentType: "subagent",
      description: "",
      status: "error",
      startedAt: now - event.durationMs,
      durationMs: event.durationMs,
      error: event.error,
    };
    return withEval(map, event.evalId, now, [
      ...(evalData?.dispatches ?? []),
      orphan,
    ]);
  }
  const evalData = map[located.evalKey];
  const existing = evalData.dispatches[located.index];
  if (isTerminal(existing.status)) return map;
  const dispatches = [...evalData.dispatches];
  dispatches[located.index] = {
    ...existing,
    status: event.phase === "complete" ? "done" : "error",
    durationMs: event.durationMs,
    error: event.phase === "error" ? event.error : undefined,
  };
  return withEval(map, located.evalKey, now, dispatches);
}

export function finalizeRunning(map: WorkflowMap, now: number): WorkflowMap {
  let changed = false;
  const next: WorkflowMap = {};
  for (const [evalKey, evalData] of Object.entries(map)) {
    if (!evalData.dispatches.some((d) => d.status === "running")) {
      next[evalKey] = evalData;
      continue;
    }
    changed = true;
    next[evalKey] = {
      ...evalData,
      updatedAt: now,
      dispatches: evalData.dispatches.map((d) =>
        d.status === "running"
          ? {
              ...d,
              status: "cancelled" as const,
              durationMs: Math.max(0, now - d.startedAt),
            }
          : d
      ),
    };
  }
  return changed ? next : map;
}

export function mergeWorkflowMaps(
  stored: WorkflowMap,
  live: WorkflowMap
): WorkflowMap {
  const next: WorkflowMap = { ...stored };
  for (const [evalKey, liveEval] of Object.entries(live)) {
    const storedEval = next[evalKey];
    if (!storedEval) {
      next[evalKey] = liveEval;
      continue;
    }
    const byId = new Map(storedEval.dispatches.map((d) => [d.id, d]));
    for (const d of liveEval.dispatches) {
      const prior = byId.get(d.id);
      if (!prior || isTerminal(d.status) || !isTerminal(prior.status)) {
        byId.set(d.id, d);
      }
    }
    const ordered: WorkflowDispatch[] = [];
    const seen = new Set<string>();
    for (const d of storedEval.dispatches) {
      ordered.push(byId.get(d.id) as WorkflowDispatch);
      seen.add(d.id);
    }
    for (const d of liveEval.dispatches) {
      if (!seen.has(d.id)) ordered.push(byId.get(d.id) as WorkflowDispatch);
    }
    next[evalKey] = {
      evalId: storedEval.evalId || liveEval.evalId,
      dispatches: ordered,
      updatedAt: Math.max(storedEval.updatedAt, liveEval.updatedAt),
    };
  }
  return next;
}

export interface WorkflowCounts {
  total: number;
  finished: number;
  failed: number;
  cancelled: number;
  running: number;
}

export function workflowCounts(evalData: WorkflowEval): WorkflowCounts {
  const counts: WorkflowCounts = {
    total: 0,
    finished: 0,
    failed: 0,
    cancelled: 0,
    running: 0,
  };
  for (const d of evalData.dispatches) {
    counts.total += 1;
    if (d.status === "running") counts.running += 1;
    else counts.finished += 1;
    if (d.status === "error") counts.failed += 1;
    if (d.status === "cancelled") counts.cancelled += 1;
  }
  return counts;
}

export function dispatchElapsedMs(d: WorkflowDispatch, now: number): number {
  return d.durationMs ?? Math.max(0, now - d.startedAt);
}

export function workflowElapsedMs(evalData: WorkflowEval, now: number): number {
  if (evalData.dispatches.length === 0) return 0;
  const earliest = Math.min(...evalData.dispatches.map((d) => d.startedAt));
  if (evalData.dispatches.some((d) => d.status === "running")) {
    return Math.max(0, now - earliest);
  }
  const latestEnd = Math.max(
    ...evalData.dispatches.map((d) => d.startedAt + dispatchElapsedMs(d, now))
  );
  return Math.max(0, latestEnd - earliest);
}

export function formatWorkflowTiming(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export interface WorkflowAggregate {
  phaseCount: number;
  total: number;
  finished: number;
  failed: number;
  cancelled: number;
  running: number;
  runningLabel: string | null;
  activeEvalId: string | null;
}

export function aggregateWorkflows(map: WorkflowMap): WorkflowAggregate {
  const agg: WorkflowAggregate = {
    phaseCount: 0,
    total: 0,
    finished: 0,
    failed: 0,
    cancelled: 0,
    running: 0,
    runningLabel: null,
    activeEvalId: null,
  };
  let latestRunningStart = -1;
  let newestUpdated = -1;
  let newestEvalId: string | null = null;
  for (const [evalId, evalData] of Object.entries(map)) {
    if (evalData.dispatches.length === 0) continue;
    agg.phaseCount += 1;
    if (evalData.updatedAt > newestUpdated) {
      newestUpdated = evalData.updatedAt;
      newestEvalId = evalId;
    }
    const counts = workflowCounts(evalData);
    agg.total += counts.total;
    agg.finished += counts.finished;
    agg.failed += counts.failed;
    agg.cancelled += counts.cancelled;
    agg.running += counts.running;
    for (const d of evalData.dispatches) {
      if (d.status === "running" && d.startedAt > latestRunningStart) {
        latestRunningStart = d.startedAt;
        agg.runningLabel = d.label;
        agg.activeEvalId = evalId;
      }
    }
  }
  if (!agg.activeEvalId) agg.activeEvalId = newestEvalId;
  return agg;
}

export function sortWorkflowEvals(map: WorkflowMap): WorkflowEval[] {
  return Object.values(map)
    .filter((e) => e.dispatches.length > 0)
    .sort(
      (a, b) =>
        Math.min(...a.dispatches.map((d) => d.startedAt)) -
        Math.min(...b.dispatches.map((d) => d.startedAt))
    );
}
