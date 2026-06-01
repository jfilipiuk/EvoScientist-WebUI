"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Puzzle, RotateCw, Trash2 } from "lucide-react";

interface SkillCard {
  name: string;
  description: string;
  dir: string;
}

export function SkillsMarketplace() {
  const [skills, setSkills] = useState<SkillCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/skills");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load skills");
      setSkills(data.skills ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load skills");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const uninstall = async (name: string) => {
    if (!window.confirm(`Uninstall the "${name}" skill?`)) return;
    setRemoving(name);
    try {
      const res = await fetch(`/api/skills?name=${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "Failed to uninstall");
      }
      setSkills((prev) => prev.filter((s) => s.name !== name));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to uninstall");
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1024px] px-6 py-8">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold">Research Skills</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Skills installed for EvoScientist. Anything you install from
              elsewhere shows up here automatically.
            </p>
          </div>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            aria-label="Refresh"
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RotateCw
              className={loading ? "size-4 animate-spin" : "size-4"}
              aria-hidden="true"
            />
          </button>
        </header>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2
              className="size-4 animate-spin"
              aria-hidden="true"
            />
            Loading skills…
          </div>
        ) : error ? (
          <p
            role="alert"
            className="text-sm text-destructive"
          >
            {error}
          </p>
        ) : skills.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No skills installed yet.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {skills.map((s) => (
              <div
                key={s.name}
                className="group relative rounded-lg border border-border bg-card p-4 pr-12"
              >
                <div className="flex items-start gap-3">
                  <Puzzle
                    className="mt-0.5 size-5 shrink-0 text-[var(--brand)]"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <h3 className="break-words font-medium">{s.name}</h3>
                    <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">
                      {s.description || "No description."}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => uninstall(s.name)}
                  disabled={removing === s.name}
                  aria-label={`Uninstall ${s.name}`}
                  title={`Uninstall ${s.name}`}
                  className="absolute right-2 top-2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring md:opacity-0 md:focus-visible:opacity-100 md:group-hover:opacity-100"
                >
                  {removing === s.name ? (
                    <Loader2
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Trash2
                      className="size-4"
                      aria-hidden="true"
                    />
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
