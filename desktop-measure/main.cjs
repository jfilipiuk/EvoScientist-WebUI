// Windows measurements for the desktop shell (issue #57, W03a), run from a
// minimal Electron main process, as the app will be.
//
//   electron.exe . --mode=consoles       measurement 1 (needs EVOSCI)
//   electron.exe . --mode=orphan         measurement 3 (driven by orphan_check.ps1)
//   electron.exe . --mode=pipefill       measurement 4, stand-in writing 1 MiB to stderr (READ)
//   electron.exe . --mode=backpressure   measurement 4, EvoSci update (needs EVOSCI, READ)
//
// Environment: MEASURE_OUT (folder for logs and <mode>.result.json), EVOSCI
// (path to EvoSci.exe), WORKDIR (workspace folder), UPDATE_VERSION (release
// for `EvoSci update --version`, default 0.3.7), READ (stdout|both: whether
// the parent reads stderr). The results are records, not gates: the process
// exits 0 unless the harness itself failed.
const { app, BrowserWindow } = require("electron");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const mode = (process.argv.find((a) => a.startsWith("--mode=")) || "").slice("--mode=".length);
const outDir = process.env.MEASURE_OUT || path.join(process.cwd(), "measure-out");
fs.mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, `${mode}.log`);
const t0 = Date.now();
const log = (msg) => {
  const line = `${new Date().toISOString()} +${Date.now() - t0}ms ${msg}`;
  fs.appendFileSync(logFile, line + "\n");
  console.log(line);
};
const result = { mode, electron: process.versions.electron, node: process.versions.node, steps: [] };
// Written after every child exits, so a job killed by its timeout still
// leaves what was measured so far.
const writeResult = () => fs.writeFileSync(path.join(outDir, `${mode}.result.json`), JSON.stringify(result, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PIPE_SIZE_UPPER = 192 * 1024; // the issue's upper estimate of a full pipe
const read = process.env.READ === "both" ? "both" : "stdout";

// One child, logged. `stdio` defaults to three pipes; `readStderr: false`
// leaves stderr unread (measurement 4). `until(event)` resolves `matched` on a
// matching stdout JSON line. Unless `raceExit` is false, `matched` also
// resolves when the child exits first ({ exited_without_match }), so a step
// never waits out its timeout for a child that is gone. `EvoSci update` sets
// it false: EvoSci exits right after the handover, and its helper writes the
// terminal line later on the same pipe.
function runChild(label, file, args, opts = {}) {
  const stdio = opts.stdio || ["pipe", "pipe", "pipe"];
  const started = Date.now();
  const child = spawn(file, args, {
    cwd: opts.cwd || outDir,
    env: { ...process.env, ...(opts.env || {}) },
    stdio,
    windowsHide: true,
  });
  const step = {
    label,
    file,
    args,
    stdio,
    pid: child.pid,
    stdout_lines: 0,
    stderr_bytes: 0,
    stderr_bytes_after_exit: 0,
    stderr_first_ms: null,
    stderr_last_ms: null,
    events: [],
  };
  result.steps.push(step);
  log(`[${label}] spawned pid=${child.pid} ${file} ${args.join(" ")}`);
  const outFile = path.join(outDir, `${mode}.${label}.stdout.log`);
  const errFile = path.join(outDir, `${mode}.${label}.stderr.log`);
  let resolveMatch;
  const matched = new Promise((r) => (resolveMatch = r));
  if (child.stdout) {
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      step.stdout_lines += 1;
      step.last_stdout = line.slice(0, 300);
      fs.appendFileSync(outFile, `+${Date.now() - started}ms ${line}\n`);
      let ev = null;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      step.events.push({ t_ms: Date.now() - started, event: ev.event, stage: ev.stage, status: ev.status, code: ev.code });
      if (opts.until && opts.until(ev)) resolveMatch(ev);
    });
  }
  if (child.stderr && opts.readStderr !== false) {
    child.stderr.on("data", (b) => {
      const t = Date.now() - started;
      step.stderr_bytes += b.length;
      if (step.exit) step.stderr_bytes_after_exit += b.length;
      if (step.stderr_first_ms === null) step.stderr_first_ms = t;
      step.stderr_last_ms = t;
      fs.appendFileSync(errFile, b);
    });
  }
  const exited = new Promise((r) =>
    child.on("exit", (code, signal) => {
      step.exit = { code, signal, t_ms: Date.now() - started };
      log(`[${label}] exit code=${code} signal=${signal} after ${Date.now() - started}ms`);
      writeResult();
      r(step.exit);
    }),
  );
  if (opts.raceExit !== false) exited.then((e) => resolveMatch({ exited_without_match: e }));
  child.on("error", (e) => {
    step.spawn_error = String(e);
    log(`[${label}] spawn error ${e}`);
    resolveMatch({ spawn_error: String(e) });
  });
  return { child, step, exited, matched };
}

function withTimeout(promise, ms, what) {
  return Promise.race([promise, sleep(ms).then(() => ({ timeout: what }))]);
}

async function killTree(pid, label) {
  const k = runChild(`taskkill-${label}`, "taskkill.exe", ["/T", "/F", "/PID", String(pid)]);
  await withTimeout(k.exited, 30_000, "taskkill");
}

// The update helper and uv processes still running (the helper is not
// EvoSci's child after the handover). Lists them; ends nothing.
function updateProcesses() {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'evosci-update-helper' -or $_.Name -match '^uv' } | Select-Object ProcessId,ParentProcessId,Name,CommandLine) | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 60_000 },
    ).trim();
    const parsed = out ? JSON.parse(out) : [];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    return [{ error: String(e) }];
  }
}

const isDeployEvent = (name) => (ev) => ev.event === name || ev.event === "error";
const isUpdateTerminal = (ev) => ev.stage === "update" && (ev.status === "done" || ev.status === "error");
// An update that refused before doing anything measures nothing.
const updateRefused = (ev) => Boolean(ev && ev.status === "error" && ev.code === "manual_update");

// Processes the issue names for measurement 1 that a hosted runner can start.
// (The npx MCP server and the agent's Git Bash need a model; see README.)
const EXPECTED_EXES = ["python.exe", "uv.exe", "node.exe", "git.exe", "powershell.exe", "taskkill.exe"];

async function consoles() {
  const evosci = process.env.EVOSCI;
  const workdir = process.env.WORKDIR || path.join(outDir, "workspace");
  fs.mkdirSync(workdir, { recursive: true });
  const stopFile = path.join(outDir, "consoles.stop");
  fs.rmSync(stopFile, { force: true });

  const watcher = runChild(
    "watcher",
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(__dirname, "console_watch.ps1"),
      "-RootPid",
      String(process.pid),
      "-Out",
      path.join(outDir, "consoles.watch.jsonl"),
      "-StopFile",
      stopFile,
    ],
    { raceExit: false },
  );
  await withTimeout(new Promise((r) => watcher.child.stdout.once("data", r)), 60_000, "watcher ready");
  log("watcher ready");

  // 1. setup: uv, Node and Git downloads run as its children.
  const setup = runChild("setup", evosci, ["setup", "--json"], { cwd: workdir });
  await withTimeout(setup.exited, 20 * 60_000, "setup");

  // 2. a child that inherits Electron's stderr: libuv then omits CREATE_NO_WINDOW.
  const inherit = runChild("version-inherited-stderr", evosci, ["--version", "--json"], {
    stdio: ["pipe", "pipe", "inherit"],
    cwd: workdir,
  });
  await withTimeout(inherit.exited, 120_000, "version");

  // 3. deploy, stopped the documented way: close stdin, wait for `stopped`.
  const d1 = runChild("deploy", evosci, ["deploy", "--json"], { cwd: workdir, until: isDeployEvent("ready") });
  const ready1 = await withTimeout(d1.matched, 5 * 60_000, "ready");
  log(`[deploy] ready or error: ${JSON.stringify(ready1)}`);
  if (!d1.step.exit) {
    await sleep(10_000); // let the backend's own children start
    d1.child.stdin.end();
    const stopped = await withTimeout(d1.exited, 20_000, "stopped");
    if (stopped.timeout) await killTree(d1.child.pid, "deploy");
  }

  // 4. deploy again, ended with taskkill /T /F (the app's fallback), so
  //    taskkill itself is a measured child.
  const d2 = runChild("deploy-killed", evosci, ["deploy", "--json"], { cwd: workdir, until: isDeployEvent("ready") });
  await withTimeout(d2.matched, 5 * 60_000, "ready");
  if (!d2.step.exit) {
    await sleep(5_000);
    await killTree(d2.child.pid, "deploy-killed");
    await withTimeout(d2.exited, 20_000, "deploy-killed exit");
  }

  // 5. update: EvoSci hands over to its PowerShell helper and exits; the
  //    helper runs uv and the new setup and writes the terminal line.
  const version = process.env.UPDATE_VERSION || "0.3.7";
  const up = runChild("update", evosci, ["update", "--json", "--version", version], {
    cwd: workdir,
    until: isUpdateTerminal,
    raceExit: false,
  });
  const terminal = await withTimeout(up.matched, 25 * 60_000, "update terminal line");
  log(`[update] terminal: ${JSON.stringify(terminal)}`);
  result.update_terminal = terminal;
  if (updateRefused(terminal)) result.invalid = "update refused with manual_update: the helper never ran";
  up.child.stdin.end();

  await sleep(3_000);
  fs.writeFileSync(stopFile, "");
  await withTimeout(watcher.exited, 30_000, "watcher stop");

  // Summarise the watcher's lines.
  const lines = fs
    .readFileSync(path.join(outDir, "consoles.watch.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l.replace(/^﻿/, "")));
  const probes = lines.filter((l) => l.kind === "console");
  const exesSeen = [...new Set(probes.map((l) => l.exe.toLowerCase()))].sort();
  result.summary = {
    processes_probed: new Set(probes.map((l) => l.pid)).size,
    // A console with a window handle (hwnd=0x0 is a console without a window,
    // what a CREATE_NO_WINDOW child gets).
    with_console_window: probes
      .filter((l) => l.state.startsWith("hwnd=") && !l.state.startsWith("hwnd=0x0 "))
      .map((l) => `${l.exe} pid=${l.pid} ${l.state}`),
    visible_console: probes.filter((l) => l.state.includes("visible=true")).map((l) => `${l.exe} pid=${l.pid}`),
    new_visible_console_windows: lines.filter((l) => l.kind === "visible_console_window"),
    exes_seen: exesSeen,
    // Named by the issue but never probed: too short-lived for the 150 ms poll,
    // or never started. Their absence is not a clean result.
    missing_exes: EXPECTED_EXES.filter((e) => !exesSeen.includes(e)),
  };
  log(`summary ${JSON.stringify(result.summary)}`);
  return 0;
}

async function orphan() {
  // A UI-server stand-in spawned the way the app will spawn dist/server.js.
  const ui = runChild("ui-standin", process.execPath, [path.join(__dirname, "ui-standin.cjs")], {
    env: { ELECTRON_RUN_AS_NODE: "1" },
    raceExit: false,
  });
  await new Promise((r) => ui.child.stdout.once("data", r));
  // Written whole, then renamed: orphan_check.ps1 reads it as soon as it exists.
  const pidsFile = path.join(outDir, "orphan.pids.json");
  fs.writeFileSync(`${pidsFile}.tmp`, JSON.stringify({ main: process.pid, ui: ui.child.pid }));
  fs.renameSync(`${pidsFile}.tmp`, pidsFile);
  log(`pids main=${process.pid} ui=${ui.child.pid}; waiting to be killed`);
  writeResult();
  await new Promise(() => {}); // orphan_check.ps1 ends this process
}

// The pipe mechanics alone: a child writes 1 MiB to stderr with blocking
// writes while the parent reads only stdout (READ=stdout) or both.
async function pipefill() {
  result.read = read;
  const w = runChild(`writer-read-${read}`, process.execPath, [path.join(__dirname, "stderr-writer.cjs")], {
    env: { ELECTRON_RUN_AS_NODE: "1" },
    readStderr: read === "both",
    until: (ev) => ev.done === true,
  });
  const done = await withTimeout(w.matched, 60_000, "writer done");
  const lastProgress = (() => {
    try {
      return JSON.parse(w.step.last_stdout).stderr_written;
    } catch {
      return null;
    }
  })();
  result.finished = Boolean(done && done.done);
  result.stderr_written_before_stop = lastProgress;
  result.verdict = result.finished
    ? `wrote all 1 MiB to stderr (read=${read})`
    : `blocked after ${lastProgress} bytes of stderr (read=${read})`;
  log(`[pipefill] ${result.verdict}`);
  if (!w.step.exit) await killTree(w.child.pid, "writer");
  return 0;
}

async function backpressure() {
  const version = process.env.UPDATE_VERSION || "0.3.7";
  const workdir = process.env.WORKDIR || path.join(outDir, "workspace");
  fs.mkdirSync(workdir, { recursive: true });
  result.read = read;
  const up = runChild(`update-read-${read}`, process.env.EVOSCI, ["update", "--json", "--version", version], {
    cwd: workdir,
    readStderr: read === "both",
    until: isUpdateTerminal,
    raceExit: false,
  });
  // Log a heartbeat so a stall shows as time without stdout lines.
  let lastLines = 0;
  const beat = setInterval(() => {
    if (up.step.stdout_lines !== lastLines) {
      lastLines = up.step.stdout_lines;
      return;
    }
    log(`[backpressure] no new stdout line; ${up.step.stdout_lines} so far, stderr bytes read ${up.step.stderr_bytes}`);
  }, 60_000);
  const terminal = await withTimeout(up.matched, 30 * 60_000, "update terminal line");
  clearInterval(beat);
  result.terminal = terminal;
  const timedOut = Boolean(terminal && terminal.timeout);
  if (timedOut) result.update_processes_alive = updateProcesses();
  const helperAlive =
    timedOut && result.update_processes_alive.some((p) => p.CommandLine && /evosci-update-helper/.test(p.CommandLine));

  if (updateRefused(terminal)) {
    result.verdict = "invalid: update refused with manual_update, uv never ran";
  } else if (timedOut) {
    result.verdict = helperAlive ? "stalled: no terminal line, helper still running" : "no terminal line and no helper: crashed";
  } else if (read === "both") {
    result.verdict =
      up.step.stderr_bytes < PIPE_SIZE_UPPER
        ? `finished; stderr carried ${up.step.stderr_bytes} bytes, below a full pipe, so the stdout-only leg cannot show a stall`
        : `finished; stderr carried ${up.step.stderr_bytes} bytes`;
  } else {
    result.verdict = "finished; conclusive only if the read=both leg carried more stderr than a full pipe";
  }
  log(`[backpressure] read=${read} terminal=${JSON.stringify(terminal)} verdict=${result.verdict}`);
  up.child.stdin.end();
  return 0;
}

app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  log(`mode=${mode} electron=${process.versions.electron} node=${process.versions.node} pid=${process.pid}`);
  // A hidden window, as the real app has one.
  new BrowserWindow({ show: false });
  let code = 1;
  try {
    if (mode === "consoles") code = await consoles();
    else if (mode === "orphan") code = await orphan();
    else if (mode === "pipefill") code = await pipefill();
    else if (mode === "backpressure") code = await backpressure();
    else log(`unknown mode ${mode}`);
  } catch (e) {
    log(`error ${e && e.stack ? e.stack : e}`);
    result.error = String(e);
  }
  result.exit_code = code;
  writeResult();
  app.exit(code);
});
