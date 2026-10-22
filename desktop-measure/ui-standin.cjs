// Stand-in for the UI server (`dist/server.js` under ELECTRON_RUN_AS_NODE):
// listens on a loopback port and stays alive until it is killed.
const http = require("http");

const server = http.createServer((_req, res) => res.end("ui stand-in\n"));
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ pid: process.pid, port: server.address().port })}\n`);
});
process.stdin.on("data", () => {});
setInterval(() => {}, 60_000);
