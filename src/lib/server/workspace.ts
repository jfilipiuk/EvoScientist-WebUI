// Server-only helpers for talking to the active EvoScientist deployment's
// on-disk workspace. Shared by the workspace upload/list/read API routes.
//
// The "workspace" is the working directory of the currently running langgraph
// dev (where the agent reads/writes real files via its file tools). It is NOT
// the agent's in-memory `files` state — that lives in thread state and is
// managed through the SDK.

import { promises as fs } from "fs";
import { homedir } from "os";
import { join, relative, resolve, sep } from "path";
import type { NextRequest } from "next/server";

export const WORKSPACE_SIDECAR = join(
  homedir(),
  ".config",
  "evoscientist",
  "langgraph_dev.workspace.json"
);

interface WorkspaceSidecar {
  workspace?: unknown;
  pid?: unknown;
}

/** True if the name contains any C0/C1 control char, DEL, or a line/paragraph
 *  separator. A newline in a filename would otherwise be spliced into the
 *  prompt sent to the agent (instruction injection); control chars have no
 *  place in a filename. */
export function hasControlChar(name: string): boolean {
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (
      code < 0x20 || // C0 controls (incl. NUL, tab, newline)
      code === 0x7f || // DEL
      (code >= 0x80 && code <= 0x9f) || // C1 controls
      code === 0x2028 || // line separator
      code === 0x2029 // paragraph separator
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// What the workspace browser hides
//
// Single source of truth for "noise" the file tree, direct file access, and the
// download-all zip all agree on. Edit these lists to change what's shown.
// Matched case-sensitively against each path segment.
// ---------------------------------------------------------------------------

/** Exact entry names treated as internal/noise — never research artifacts. */
export const IGNORED_NAMES = new Set([
  "large_tool_results", // EvoScientist: large tool outputs spilled to disk, keyed by call id
  "conversation_history", // EvoScientist: internal conversation transcripts
  "__pycache__", // Python bytecode cache
  "node_modules", // JS deps
  "__MACOSX", // macOS archive cruft
]);

/** Filename suffixes hidden the same way (build artifacts). */
export const IGNORED_SUFFIXES = [".pyc", ".pyo"];

/**
 * True if a single entry name should be hidden from the workspace browser:
 * dotfiles (incl. `.langgraph_api`, `.DS_Store`), known-internal directories,
 * and build artifacts. Used for both listings and direct-access blocking.
 */
export function isHiddenEntry(name: string): boolean {
  if (name.startsWith(".")) return true;
  if (IGNORED_NAMES.has(name)) return true;
  return IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** `zip -x` exclude args derived from the same ignore lists, so the download
 *  archive contains exactly what the tree shows. */
export function zipExcludeArgs(): string[] {
  const patterns = [".*", "*/.*"]; // dotfiles at root and nested
  for (const name of IGNORED_NAMES) {
    patterns.push(`${name}/*`, `*/${name}/*`, name, `*/${name}`);
  }
  for (const suffix of IGNORED_SUFFIXES) {
    patterns.push(`*${suffix}`);
  }
  return patterns.flatMap((pattern) => ["-x", pattern]);
}

/** True if a process with `pid` is currently running (signal 0 = existence probe). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but we may not signal it — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Resolve the workspace of the *currently running* EvoScientist deployment.
 *
 * The sidecar records `{ workspace, pid }` of the langgraph dev that owns this
 * workspace. We only trust it when that pid is still alive — a stale sidecar
 * from a crashed/previous session must not silently redirect file access to a
 * directory the live deployment no longer uses. Falls back to the launcher env.
 */
export async function getWorkspaceDir(): Promise<string> {
  let workspace: string | undefined;
  try {
    const sidecar = JSON.parse(
      await fs.readFile(WORKSPACE_SIDECAR, "utf-8")
    ) as WorkspaceSidecar;
    const ws = sidecar.workspace;
    const pid = sidecar.pid;
    if (typeof ws === "string" && ws.trim()) {
      const hasPid = typeof pid === "number" && pid > 0;
      // With a recorded backend pid, only trust the sidecar while that process
      // is alive; older sidecars without one fall back to trusting it as before.
      if (!hasPid || isProcessAlive(pid as number)) workspace = ws;
    }
  } catch {
    // Older/manual setups may not have a sidecar. Fall back to the launcher env.
  }

  workspace ||= process.env.EVOSCIENTIST_WORKSPACE_DIR;
  if (!workspace) {
    throw new Error(
      "No active EvoScientist workspace found. Start the backend with `EvoSci deploy` first."
    );
  }

  const resolved = resolve(workspace);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error("The active EvoScientist workspace is not a directory.");
  }
  // Canonicalize so every containment check compares against the *real* root —
  // the workspace (or a parent) may itself live under a symlink (e.g. macOS
  // /tmp -> /private/tmp), which would otherwise break startsWith() checks.
  return fs.realpath(resolved);
}

/**
 * Resolve a caller-supplied relative path against `workspaceDir` and guarantee
 * the result stays inside it (no `..` escape, no absolute-path override, no
 * control chars). Returns the absolute, normalized path.
 *
 * `relPath` is treated as relative even if it starts with `/` — a leading slash
 * is stripped so an absolute path can never replace the workspace root.
 */
export function resolveInside(workspaceDir: string, relPath: string): string {
  if (hasControlChar(relPath)) {
    throw new Error("Invalid path.");
  }
  // Normalize separators and strip any leading slashes so the path is always
  // interpreted relative to the workspace root.
  const cleaned = relPath.replaceAll("\\", "/").replace(/^\/+/, "");
  // Hidden entries (dotfiles like `.langgraph_api`, internal dirs like
  // `large_tool_results`, build noise) are blocked from direct access too — not
  // just unlisted — so a crafted `?path=.langgraph_api` or `?path=large_tool_results`
  // can't read them. `..` is also caught here (and by the boundary check below).
  if (cleaned.split("/").some((seg) => seg !== "" && isHiddenEntry(seg))) {
    throw new Error("Path is not accessible.");
  }
  const target = resolve(workspaceDir, cleaned);
  // Must be the workspace dir itself or strictly within it.
  if (target !== workspaceDir && !target.startsWith(workspaceDir + sep)) {
    throw new Error("Path is outside the workspace.");
  }
  return target;
}

/**
 * Like `resolveInside`, but ALSO defeats symlink escapes: it canonicalizes the
 * target with `fs.realpath` and re-checks containment + the hidden-entry policy
 * against the real path. A symlink such as `out -> /etc` (so `out/passwd` is
 * lexically "inside") or `link -> .langgraph_api` is rejected here, even though
 * the lexical check in `resolveInside` would pass.
 *
 * `workspaceDir` MUST already be canonical (it is — `getWorkspaceDir` realpaths
 * it). Throws if the target doesn't exist or escapes. Use this for any access
 * that will then follow the path on disk (stat/read/list).
 */
export async function safeResolve(
  workspaceDir: string,
  relPath: string
): Promise<string> {
  const target = resolveInside(workspaceDir, relPath);
  let realTarget: string;
  try {
    realTarget = await fs.realpath(target);
  } catch {
    // Missing file or a broken/looping symlink — treat as inaccessible.
    throw new Error("Path is not accessible.");
  }
  if (
    realTarget !== workspaceDir &&
    !realTarget.startsWith(workspaceDir + sep)
  ) {
    throw new Error("Path is not accessible.");
  }
  // A symlink could point at a hidden/internal entry that lives inside the
  // workspace (e.g. `foo -> .langgraph_api`); re-check the canonical segments.
  const realRel = relative(workspaceDir, realTarget);
  if (
    realRel &&
    realRel.split(sep).some((seg) => seg !== "" && isHiddenEntry(seg))
  ) {
    throw new Error("Path is not accessible.");
  }
  return realTarget;
}

/**
 * Reject cross-site requests to the workspace APIs. Browsers omit `Origin` on
 * same-origin GETs and on direct navigations (open-in-tab / downloads), so we
 * lean on `Sec-Fetch-Site` when present and fall back to an Origin check.
 */
export function isCrossOrigin(request: NextRequest): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (
    site &&
    site !== "same-origin" &&
    site !== "same-site" &&
    site !== "none"
  ) {
    return true; // explicit cross-site request
  }
  const origin = request.headers.get("origin");
  return !!origin && origin !== request.nextUrl.origin;
}
