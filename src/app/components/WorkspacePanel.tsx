"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FileText,
  RefreshCw,
  Download,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  WorkspaceFileDialog,
} from "@/app/components/WorkspaceFileDialog";
import type { WorkspaceEntry } from "@/app/api/workspace/route";

async function listDir(path: string): Promise<WorkspaceEntry[]> {
  const res = await fetch(`/api/workspace?${new URLSearchParams({ path })}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || "Failed to list workspace.");
  return (body?.entries ?? []) as WorkspaceEntry[];
}

export function WorkspacePanel() {
  // Listing cache keyed by directory path ("" = workspace root).
  const [children, setChildren] = useState<Record<string, WorkspaceEntry[]>>(
    {}
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [rootLoading, setRootLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{
    path: string;
    size: number;
  } | null>(null);

  const loadDir = useCallback(async (path: string) => {
    setLoading((prev) => new Set(prev).add(path));
    try {
      const entries = await listDir(path);
      setChildren((prev) => ({ ...prev, [path]: entries }));
      if (path === "") setError(null);
      return entries;
    } catch (err) {
      if (path === "") {
        setError(err instanceof Error ? err.message : "Failed to load.");
      }
      throw err;
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }, []);

  const refresh = useCallback(async () => {
    setRootLoading(true);
    // Re-fetch the root plus every currently-expanded directory so an open tree
    // stays open and in sync with what the agent has written since.
    const toLoad = ["", ...expanded];
    await Promise.allSettled(toLoad.map((p) => loadDir(p)));
    setRootLoading(false);
  }, [expanded, loadDir]);

  // Initial load. loadDir surfaces root failures via `error` state; catch the
  // rejection here so it doesn't become an unhandled promise rejection.
  useEffect(() => {
    setRootLoading(true);
    void loadDir("")
      .catch(() => {})
      .finally(() => setRootLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleDir = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          if (!children[path]) void loadDir(path).catch(() => {});
        }
        return next;
      });
    },
    [children, loadDir]
  );

  const renderEntries = (path: string, depth: number): React.ReactNode => {
    const entries = children[path];
    if (!entries) return null;
    if (entries.length === 0 && depth === 0) {
      return (
        <p className="px-2 py-6 text-center text-xs text-muted-foreground">
          No files in the workspace yet
        </p>
      );
    }
    return entries.map((entry) => {
      const isOpen = expanded.has(entry.path);
      const isLoadingDir = loading.has(entry.path);
      return (
        <div key={entry.path}>
          <button
            type="button"
            onClick={() =>
              entry.type === "dir"
                ? toggleDir(entry.path)
                : setSelected({ path: entry.path, size: entry.size })
            }
            className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm text-foreground transition-colors hover:bg-muted"
            style={{ paddingLeft: `${depth * 14 + 4}px` }}
            title={entry.name}
          >
            {entry.type === "dir" ? (
              <>
                <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                  {isLoadingDir ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : isOpen ? (
                    <ChevronDown className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                </span>
                <Folder className="size-4 shrink-0 text-[var(--brand)]" />
              </>
            ) : (
              <>
                <span className="size-4 shrink-0" />
                <FileText className="size-4 shrink-0 text-muted-foreground" />
              </>
            )}
            <span className="truncate">{entry.name}</span>
          </button>
          {entry.type === "dir" && isOpen && renderEntries(entry.path, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 pb-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-tertiary">
          Working directory
        </span>
        <div className="flex items-center gap-0.5">
          <a
            href="/api/workspace/download"
            download
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="Download the whole workspace as a zip"
          >
            <Download className="size-3.5" />
            All
          </a>
          <button
            type="button"
            onClick={refresh}
            disabled={rootLoading}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            aria-label="Refresh workspace"
            title="Refresh"
          >
            <RefreshCw
              className={cn("size-3.5", rootLoading && "animate-spin")}
            />
          </button>
        </div>
      </div>

      {error ? (
        <p className="px-2 py-6 text-center text-xs text-muted-foreground">
          {error}
        </p>
      ) : rootLoading && !children[""] ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="-mx-1">{renderEntries("", 0)}</div>
      )}

      <WorkspaceFileDialog
        path={selected?.path ?? null}
        size={selected?.size}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
