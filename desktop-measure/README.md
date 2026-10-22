# Desktop measurements (issue #57, W03a)

Windows behaviours the desktop shell depends on, measured before it is written. Not shipped, not part of CI. The workflow `.github/workflows/w03a-measure.yml` runs on a push to a `measure/**` branch. The results are records in the job logs and the `measure-*` artifacts; the jobs do not fail on them.

The core: `scripts/install.ps1` installs the newest release, then the wheel built from EvoScientist `main` goes into the tool environment with `uv pip install --reinstall-package`, as the core's own update smoke test does. Installed through `install.ps1` instead, the wheel would leave a `path` source in uv's receipt, and `EvoSci update` would refuse with `manual_update`.

| # | Job | What it records |
|---|---|---|
| 1 | `consoles` | The descendants of an Electron main process (`EvoSci setup --json`, `deploy --json` stopped by closing stdin, a second `deploy` ended with `taskkill /T /F`, `update --json` with its PowerShell helper, and `--version --json` with an inherited stderr): whether each has a console, a console window, and a visible one (`console_watch.ps1`). The update helper's subtree stays covered after `EvoSci` exits. `missing_exes` lists the processes the issue names that were never probed: too short-lived for the 150 ms poll, or never started. |
| 3 | `orphan` | Whether a UI-server stand-in survives `TerminateProcess` on the main process, running and suspended (`orphan_check.ps1`), and whether it sits in a job object. |
| 4 | `backpressure` | From a parent that reads only stdout, and one that reads both streams: a stand-in that writes 1 MiB to stderr with blocking writes (where the pipe fills), then `EvoSci update --json --version 0.3.7` with a cold uv cache (whether the terminal line arrives, how many stderr bytes the update writes, and how many arrive after `EvoSci.exe` exits). Below a full pipe of stderr, the stdout-only update leg cannot show a stall, and its verdict says so. |
| 7 | `arm64` | What an x64 Node sees on Windows on Arm, including `PROCESSOR_ARCHITECTURE` in the registry. |

Needs a real machine with a desktop session:

- measurements 2 (sign-out and shutdown), 5 (Defender cold start) and 6 (Documents redirected by OneDrive);
- measurement 1 again with Windows Terminal as the default terminal;
- measurement 1 for the npx MCP server and the agent's Git Bash, which start only when a model runs a task.
