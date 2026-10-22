// Measurement 7: what an x64 Node under emulation on Windows on Arm can see.
// Run with an x64 node.exe on GitHub's windows-11-arm runner.
const { execFileSync } = require("child_process");
const os = require("os");

const KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";

function reg(value) {
  try {
    const out = execFileSync("reg.exe", ["query", KEY, "/v", value], { encoding: "utf8", windowsHide: true });
    const m = out.match(new RegExp(`${value}\\s+REG_\\w+\\s+(\\S+)`));
    return m ? m[1] : `unparsed: ${out.trim()}`;
  } catch (e) {
    return `error: ${e.message}`;
  }
}

const result = {
  measurement: 7,
  node: process.version,
  "process.arch": process.arch,
  "os.arch()": os.arch(),
  "os.machine()": os.machine(),
  "env.PROCESSOR_ARCHITECTURE": process.env.PROCESSOR_ARCHITECTURE ?? null,
  "env.PROCESSOR_ARCHITEW6432": process.env.PROCESSOR_ARCHITEW6432 ?? null,
  "registry PROCESSOR_ARCHITECTURE": reg("PROCESSOR_ARCHITECTURE"),
};
result.verdict =
  result["registry PROCESSOR_ARCHITECTURE"] === "ARM64"
    ? "registry says ARM64: usable to detect Windows on Arm from an x64 process"
    : "registry does not say ARM64";
console.log(JSON.stringify(result, null, 2));
