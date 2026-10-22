# Desktop measurements (issue #57, W03a)

Windows behaviours the desktop shell depends on, measured before it is written. Not shipped, not part of CI. The workflow `.github/workflows/w03a-measure.yml` runs on a push to a `measure/**` branch.

| # | Job | What it records |
|---|---|---|
| 1 | `consoles` | Every descendant of an Electron main process (`EvoSci setup --json`, `deploy --json` stopped by closing stdin, a second `deploy` ended with `taskkill /T /F`, `update --json` and its PowerShell helper, and `--version --json` with an inherited stderr): whether it has a console, and whether that console window is visible (`console_watch.ps1`). |
| 3 | `orphan` | Whether a UI-server stand-in survives `TerminateProcess` on the main process, running and suspended (`orphan_check.ps1`), and whether it sits in a job object. |
| 4 | `backpressure` | `EvoSci update --json --version 0.3.7` with a cold uv cache, from a parent that reads only stdout, and one that reads both streams: whether the terminal line arrives. |
| 7 | `arm64` | What an x64 Node sees on Windows on Arm, including `PROCESSOR_ARCHITECTURE` in the registry. |

Results are uploaded as artifacts (`measure-*`) and printed in the job logs. Measurements 2, 5 and 6 need a desktop session and run on a real machine.

The npx MCP server and the agent's Git Bash start only when a model runs a task, so measurement 1 covers them on a real machine with a configured model.
