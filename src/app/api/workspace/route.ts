import { promises as fs } from "fs";
import { extname } from "path";
import { NextRequest, NextResponse } from "next/server";
import {
  getWorkspaceDir,
  safeResolve,
  isHiddenEntry,
  isCrossOrigin,
} from "@/lib/server/workspace";

export const runtime = "nodejs";

// Cap how many entries a single directory listing returns so a pathological
// directory can't stall the UI or the response.
const MAX_ENTRIES = 2000;

export interface WorkspaceEntry {
  name: string;
  /** Path relative to the workspace root, e.g. "artifacts/report.md". */
  path: string;
  type: "dir" | "file";
  size: number;
  /** Last-modified epoch ms. */
  mtime: number;
  /** Lowercase extension without the dot, "" for none/dirs. */
  ext: string;
}

export async function GET(request: NextRequest) {
  try {
    if (isCrossOrigin(request)) {
      return NextResponse.json(
        { error: "Cross-origin workspace access is not allowed." },
        { status: 403 }
      );
    }

    const relPath = request.nextUrl.searchParams.get("path") ?? "";
    const workspaceDir = await getWorkspaceDir();
    const dir = await safeResolve(workspaceDir, relPath);

    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) {
      return NextResponse.json(
        { error: "Not a directory." },
        { status: 400 }
      );
    }

    const dirents = await fs.readdir(dir, { withFileTypes: true });
    const entries: WorkspaceEntry[] = [];
    for (const dirent of dirents) {
      if (entries.length >= MAX_ENTRIES) break;
      // Skip noise (dotfiles, internal dirs, build artifacts) — not research
      // artifacts. See isHiddenEntry for the full policy.
      if (isHiddenEntry(dirent.name)) continue;

      const childRel = relPath
        ? `${relPath.replace(/\/+$/, "")}/${dirent.name}`
        : dirent.name;

      // safeResolve canonicalizes and re-checks containment, so a symlink that
      // escapes the workspace (or points at a hidden entry) is skipped, not
      // listed. Also drops anything that won't stat (broken link, or the agent
      // deleting a file mid-listing).
      let size = 0;
      let mtime = 0;
      let entryIsDir = dirent.isDirectory();
      try {
        const realChild = await safeResolve(workspaceDir, childRel);
        const entryStat = await fs.stat(realChild);
        size = entryStat.size;
        mtime = entryStat.mtimeMs;
        entryIsDir = entryStat.isDirectory();
      } catch {
        continue;
      }

      entries.push({
        name: dirent.name,
        path: childRel,
        type: entryIsDir ? "dir" : "file",
        size,
        mtime,
        ext: entryIsDir ? "" : extname(dirent.name).slice(1).toLowerCase(),
      });
    }

    // Directories first, then files, each alphabetical (case-insensitive).
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    const parent =
      relPath && relPath !== "."
        ? relPath.replace(/\/+$/, "").split("/").slice(0, -1).join("/")
        : null;

    return NextResponse.json({ path: relPath, parent, entries });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to list workspace.",
      },
      { status: 400 }
    );
  }
}
