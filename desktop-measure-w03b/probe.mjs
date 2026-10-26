// "Measure before W03b" (issue #57): run the core's install.ps1 the way the
// desktop app will, from a Node parent with three pipes and windowsHide, and
// record exit code and the raw bytes of stdout and stderr per case.
//
//   node probe.mjs --script <install.ps1> --out <dir> [--version 0.3.8] [--cases a,b]
//
// Plain Node (no dependencies), so it also runs under Electron with
// ELECTRON_RUN_AS_NODE=1. Each case gets its own home under
// C:\Users\Public\Evo W03b ąę\<case> (USERPROFILE, HOMEDRIVE/HOMEPATH,
// APPDATA, LOCALAPPDATA, TEMP/TMP; EVOSCIENTIST_DATA_DIR unset), as the core's
// own Windows tests isolate a profile. Results: <out>/<case>.stdout.bin,
// .stderr.bin, .events.jsonl (chunks in arrival order) and <out>/summary.json.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const SCRIPT = path.resolve(args.script ?? "install.ps1");
const OUT = path.resolve(args.out ?? "out");
const VERSION = args.version ?? "0.3.8";
const BASE = args.base ?? "C:\\Users\\Public\\Evo W03b ąę";
const POWERSHELL = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const UTF8_PREFIX = "[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false; ";
const CASE_TIMEOUT_MS = 15 * 60 * 1000;

fs.mkdirSync(OUT, { recursive: true });

// The issue's command (How > Install script), optionally with the UTF-8 prefix.
function installCommand({ utf8, scriptArgs }) {
  return (
    (utf8 ? UTF8_PREFIX : "") +
    "$global:LASTEXITCODE = 1; & ([scriptblock]::Create([IO.File]::ReadAllText($env:EVOSCI_INSTALL_SCRIPT))) " +
    scriptArgs +
    "; exit $LASTEXITCODE"
  );
}

// PSModulePath is dropped by default, as the app would: a parent started from
// pwsh 7 passes its module path on, and Windows PowerShell 5.1 then fails to
// load its own modules (run 1). keepModulePath keeps it to show that.
function homeEnv(home, { keepModulePath = false } = {}) {
  const drive = home.slice(0, 2);
  const env = { ...process.env };
  if (!keepModulePath) for (const k of Object.keys(env)) if (k.toUpperCase() === "PSMODULEPATH") delete env[k];
  delete env.EVOSCIENTIST_DATA_DIR;
  for (const k of Object.keys(env)) if (k.startsWith("XDG_") || k.startsWith("UV_")) delete env[k];
  Object.assign(env, {
    USERPROFILE: home,
    HOMEDRIVE: drive,
    HOMEPATH: home.slice(2),
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    TEMP: path.join(home, "AppData", "Local", "Temp"),
    TMP: path.join(home, "AppData", "Local", "Temp"),
  });
  for (const k of ["APPDATA", "LOCALAPPDATA", "TEMP"]) fs.mkdirSync(env[k], { recursive: true });
  return env;
}

function homeFor(name) {
  const home = path.join(BASE, name);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

// Spawns powershell.exe the way the app will and records everything.
function runCase(name, { home, policy, utf8 = true, scriptArgs, scriptPath = SCRIPT, extraEnv = {}, command, keepModulePath = false }) {
  return new Promise((resolve) => {
    const env = { ...homeEnv(home, { keepModulePath }), EVOSCI_INSTALL_SCRIPT: scriptPath, ...extraEnv };
    const cmd = command ?? installCommand({ utf8, scriptArgs: scriptArgs ?? `-Version ${VERSION} -NoSetup -NoModifyPath` });
    const argv = ["-NoProfile", "-NonInteractive", ...(policy ? ["-ExecutionPolicy", policy] : []), "-Command", cmd];
    const started = Date.now();
    const chunks = { stdout: [], stderr: [] };
    const events = fs.createWriteStream(path.join(OUT, `${name}.events.jsonl`));
    console.log(`\n=== ${name} (${argv.slice(0, -1).join(" ")}) home=${home}`);
    const child = spawn(POWERSHELL, argv, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child.stdin.end();
    let exit = null;
    let ended = 0;
    const timer = setTimeout(() => {
      console.log(`  timeout after ${CASE_TIMEOUT_MS} ms, taskkill /T /F`);
      spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)]);
    }, CASE_TIMEOUT_MS);
    for (const stream of ["stdout", "stderr"]) {
      child[stream].on("data", (buf) => {
        chunks[stream].push(buf);
        events.write(JSON.stringify({ t: Date.now() - started, stream, hex: buf.toString("hex") }) + "\n");
        process.stdout.write(`  [${stream}] ${buf.toString("utf8").replace(/\r?\n$/, "").replace(/\n/g, `\n  [${stream}] `)}\n`);
      });
      child[stream].on("end", () => {
        if (++ended === 2 && exit) finish();
      });
    }
    child.on("error", (err) => {
      exit = { error: String(err) };
      finish();
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal, exitMs: Date.now() - started };
      if (ended === 2) finish();
    });
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      events.end();
      const out = Buffer.concat(chunks.stdout);
      const err = Buffer.concat(chunks.stderr);
      fs.writeFileSync(path.join(OUT, `${name}.stdout.bin`), out);
      fs.writeFileSync(path.join(OUT, `${name}.stderr.bin`), err);
      resolve({ name, home, policy: policy ?? "(none)", utf8, keepModulePath, argv, ...exit, closedMs: Date.now() - started, ...analyse(out, err, home) });
    }
  });
}

// What the app needs to know about the bytes.
function analyse(out, err, home) {
  const o = out.toString("utf8");
  const e = err.toString("utf8");
  const lines = (s) => s.split(/\r?\n/).filter((l) => l.length);
  const errorLine = (s) => lines(s).filter((l) => l.startsWith("Error:"));
  const nonUtf8 = (b) => b.toString("utf8").includes("\uFFFD");
  // Where the home path shows up, and whether it decodes intact as UTF-8.
  const homeMentions = (s) => lines(s).filter((l) => l.includes(home.slice(0, 18)) || l.includes("Evo W03b"));
  return {
    stdoutBytes: out.length,
    stderrBytes: err.length,
    stdoutHasReplacementChar: nonUtf8(out),
    stderrHasReplacementChar: nonUtf8(err),
    stdoutHasCrLf: o.includes("\r\n"),
    clixml: { stdout: o.includes("#< CLIXML"), stderr: e.includes("#< CLIXML") },
    errorLines: { stdout: errorLine(o), stderr: errorLine(e) },
    homeIntactUtf8: { stdout: o.includes(home), stderr: e.includes(home) },
    homeMentions: { stdout: homeMentions(o).slice(0, 8), stderr: homeMentions(e).slice(0, 8) },
    stdoutTail: lines(o).slice(-12),
    stderrTail: lines(e).slice(-12),
  };
}

// Facts about the PowerShell the app starts: code pages, language mode, policy.
const ENV_PROBE =
  "$o = [Console]::OutputEncoding; $i = [Console]::InputEncoding; " +
  "Write-Host ('OutputEncoding=' + $o.CodePage + ' ' + $o.WebName); Write-Host ('InputEncoding=' + $i.CodePage); " +
  "Write-Host ('OEMCP=' + [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage).CodePage); " +
  "Write-Host ('ANSICP=' + [Globalization.CultureInfo]::CurrentCulture.TextInfo.ANSICodePage); " +
  "Write-Host ('PS=' + $PSVersionTable.PSVersion); Write-Host ('PSModulePath=' + $env:PSModulePath); Write-Host ('LanguageMode=' + $ExecutionContext.SessionState.LanguageMode); " +
  "Get-ExecutionPolicy -List | ForEach-Object { Write-Host ('Policy ' + $_.Scope + '=' + $_.ExecutionPolicy) }; " +
  "Write-Host 'Write-Host ąę Zoë'; Write-Output 'Write-Output ąę Zoë'; [Console]::Error.WriteLine('Console.Error ąę Zoë'); " +
  "Write-Error 'Write-Error ąę Zoë' -ErrorAction Continue; " +
  "try { $null = Get-FileHash -LiteralPath $env:EVOSCI_INSTALL_SCRIPT -Algorithm SHA256; Write-Host 'Get-FileHash OK' } catch { Write-Host ('Get-FileHash FAILED: ' + $_.Exception.Message) }; " +
  "try { Get-Command Expand-Archive -ErrorAction Stop | Out-Null; Import-Module Microsoft.PowerShell.Archive -ErrorAction Stop; Write-Host 'Archive module OK' } catch { Write-Host ('Archive module FAILED: ' + $_.Exception.Message) }; " +
  "exit 0";

// Puts a non-uv EvoSci.exe in uv's tool bin dir (~\.local\bin with this
// profile), so install.ps1 refuses with a path in its Error: line, offline.
function plantForeignEntryPoint(home) {
  const bin = path.join(home, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"), path.join(bin, "EvoSci.exe"));
}

// Starts the installed environment's python.exe, so a reinstall refuses with
// "EvoScientist is running" and the process list (paths with ąę).
// The tool dir comes from the uv that install.ps1 recorded in tools\uv.json.
function startEnvPython(home) {
  const uvJson = path.join(home, ".evoscientist", "tools", "uv.json");
  if (!fs.existsSync(uvJson)) return null;
  const uv = JSON.parse(fs.readFileSync(uvJson, "utf8").replace(/^﻿/, "")).path;
  const dir = spawnSync(uv, ["tool", "dir"], { env: homeEnv(home), encoding: "utf8", windowsHide: true });
  const toolDir = dir.stdout.trim().split(/\r?\n/).pop();
  const py = path.join(toolDir, "evoscientist", "Scripts", "python.exe");
  console.log(`  uv=${uv} toolDir=${toolDir} python exists=${fs.existsSync(py)}`);
  if (!fs.existsSync(py)) return null;
  return spawn(py, ["-c", "import time; time.sleep(900)"], { stdio: "ignore", windowsHide: true, env: homeEnv(home) });
}

const CASES = {
  // Code pages, language mode, policy list, how each output path is encoded.
  "env-inherited-modulepath": () => runCase("env-inherited-modulepath", { home: homeFor("env"), command: UTF8_PREFIX + ENV_PROBE, keepModulePath: true }),
  "env-default": () => runCase("env-default", { home: homeFor("env"), command: ENV_PROBE }),
  "env-restricted": () => runCase("env-restricted", { home: homeFor("env"), policy: "Restricted", command: ENV_PROBE }),
  "env-restricted-utf8": () => runCase("env-restricted-utf8", { home: homeFor("env"), policy: "Restricted", command: UTF8_PREFIX + ENV_PROBE }),
  "env-clm": () => runCase("env-clm", { home: homeFor("env"), command: ENV_PROBE, extraEnv: { __PSLockdownPolicy: "4" } }),
  // Offline refusals with a home path in the Error: line, prefix off / on.
  "foreign-noprefix": async () => {
    const home = homeFor("foreign");
    plantForeignEntryPoint(home);
    return runCase("foreign-noprefix", { home, policy: "Bypass", utf8: false });
  },
  "foreign-utf8": async () => {
    const home = homeFor("foreign");
    plantForeignEntryPoint(home);
    return runCase("foreign-utf8", { home, policy: "Bypass", utf8: true });
  },
  // Missing script file; unknown option (fails before the script's try).
  "missing-file": () => runCase("missing-file", { home: homeFor("missing"), policy: "Bypass", scriptPath: path.join(BASE, "missing", "nope ą.ps1") }),
  "bad-option": () => runCase("bad-option", { home: homeFor("badopt"), policy: "Bypass", scriptArgs: `-Version ${VERSION} -NoSetup -NoModifyPaths` }),
  // A release that does not exist.
  "bad-version": () => runCase("bad-version", { home: homeFor("badver"), policy: "Bypass", scriptArgs: "-Version 0.3.99 -NoSetup -NoModifyPath" }),
  // CLM on the real command.
  "clm-install": () => runCase("clm-install", { home: homeFor("clm"), policy: "Bypass", extraEnv: { __PSLockdownPolicy: "4" } }),
  // Real installs: the default policy, Restricted (module loading), Bypass + prefix.
  "install-restricted": () => runCase("install-restricted", { home: homeFor("restricted"), policy: "Restricted" }),
  "install-default-noprefix": () => runCase("install-default-noprefix", { home: homeFor("default"), utf8: false }),
  "install-bypass-utf8": () => runCase("install-bypass-utf8", { home: homeFor("ok"), policy: "Bypass" }),
  // On the same home: a second run (repair path) and one while EvoScientist runs.
  "reinstall-utf8": () => runCase("reinstall-utf8", { home: homeFor("ok"), policy: "Bypass" }),
  "running-noprefix": async () => runningCase("running-noprefix", false),
  "running-utf8": async () => runningCase("running-utf8", true),
};

async function runningCase(name, utf8) {
  const home = homeFor("ok");
  const py = startEnvPython(home);
  if (!py) return { name, skipped: "no installed environment under the ok home (install-bypass-utf8 must run first)" };
  await new Promise((r) => setTimeout(r, 1500));
  try {
    return await runCase(name, { home, policy: "Bypass", utf8 });
  } finally {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(py.pid)]);
  }
}

const selected = args.cases ? args.cases.split(",") : Object.keys(CASES);
const summary = {
  node: process.version,
  electron: process.versions.electron ?? null,
  script: SCRIPT,
  parentPSModulePath: process.env.PSModulePath ?? null,
  scriptSha256: (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(SCRIPT)).digest("hex"),
  version: VERSION,
  base: BASE,
  results: [],
};
for (const name of selected) {
  if (!CASES[name]) throw new Error(`unknown case ${name}`);
  const result = await CASES[name]();
  summary.results.push(result);
  // Written after every case, so a cancelled job still leaves results.
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`  -> exit ${result.code ?? result.error ?? result.skipped} in ${result.exitMs ?? "-"} ms`);
}
console.log(`\nsummary: ${path.join(OUT, "summary.json")}`);
