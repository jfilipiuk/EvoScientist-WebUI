// Measurement 4 stand-in: writes 1 MiB to stderr in 4 KiB blocking writes and
// reports progress on stdout, so a parent that never reads stderr shows where
// the pipe fills. fs.writeSync blocks in WriteFile once the pipe is full.
const fs = require("fs");

const TOTAL = 1024 * 1024;
const CHUNK = Buffer.alloc(4096, "e");
let written = 0;
fs.writeSync(1, `${JSON.stringify({ started: true, pid: process.pid })}\n`);
while (written < TOTAL) {
  fs.writeSync(2, CHUNK);
  written += CHUNK.length;
  fs.writeSync(1, `${JSON.stringify({ stderr_written: written })}\n`);
}
fs.writeSync(1, `${JSON.stringify({ done: true, stderr_written: written })}\n`);
