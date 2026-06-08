"use client";

import { X, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WorkspacePanel } from "@/app/components/WorkspacePanel";

interface InspectorPanelProps {
  onClose: () => void;
}

/**
 * Dockable right-hand inspector. For now it holds the Workspace browser; it's
 * the seam where Tasks / Sub-agent steps / Logs tabs will live later (the base's
 * cramped composer-top strip migrates here). Self-contained — WorkspacePanel
 * fetches its own data, so this is just chrome + a scroll container.
 */
export function InspectorPanel({ onClose }: InspectorPanelProps) {
  return (
    <div className="flex h-full flex-col border-l border-border bg-sidebar">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <FolderOpen className="size-4 text-[var(--brand)]" />
          Workspace
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={onClose}
          aria-label="Close workspace"
          title="Close"
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <WorkspacePanel />
      </div>
    </div>
  );
}
