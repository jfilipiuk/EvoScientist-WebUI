import { NextRequest, NextResponse } from "next/server";
import { homedir } from "os";
import { join, resolve } from "path";
import { promises as fs } from "fs";

// EvoScientist installs user skills here (confirmed fixed location). We also
// check the ~/.evoscientist/skills global tier as a fallback.
const SKILL_DIRS = [
  join(homedir(), ".config", "evoscientist", "skills"),
  join(homedir(), ".evoscientist", "skills"),
];

interface SkillCard {
  name: string;
  description: string;
  dir: string;
}

// Minimal frontmatter parse — we only need name + description. Avoids pulling
// in a YAML dependency.
function parseFrontmatter(md: string): { name?: string; description?: string } {
  const match = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = match[1];
  const get = (key: string) => {
    const m = fm.match(new RegExp(`^${key}\\s*:\\s*(.+?)\\s*$`, "m"));
    if (!m) return undefined;
    return m[1].replace(/^["']|["']$/g, "").trim();
  };
  return { name: get("name"), description: get("description") };
}

async function readSkills(): Promise<SkillCard[]> {
  const skills: SkillCard[] = [];
  const seen = new Set<string>();
  for (const dir of SKILL_DIRS) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue; // dir doesn't exist
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const skillDir = join(dir, entry);
      try {
        const stat = await fs.stat(skillDir);
        if (!stat.isDirectory()) continue;
        const md = await fs.readFile(join(skillDir, "SKILL.md"), "utf-8");
        const { name, description } = parseFrontmatter(md);
        const skillName = name || entry;
        if (seen.has(skillName)) continue;
        seen.add(skillName);
        skills.push({
          name: skillName,
          description: description || "",
          dir: skillDir,
        });
      } catch {
        // no SKILL.md or unreadable — skip
      }
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function GET() {
  try {
    const skills = await readSkills();
    return NextResponse.json({ skills });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to read skills" },
      { status: 500 }
    );
  }
}

// Uninstall = remove the skill directory. Guard against path traversal and
// only delete inside the known skill dirs.
export async function DELETE(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  if (!name || /[\\/]|\.\./.test(name)) {
    return NextResponse.json({ error: "Invalid skill name" }, { status: 400 });
  }
  for (const dir of SKILL_DIRS) {
    const target = resolve(join(dir, name));
    if (!target.startsWith(resolve(dir) + "/")) continue;
    try {
      await fs.stat(target);
    } catch {
      continue; // not here
    }
    await fs.rm(target, { recursive: true, force: true });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Skill not found" }, { status: 404 });
}
