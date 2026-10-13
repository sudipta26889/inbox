// Preload for host-run maintenance scripts: maps "server-only" to an empty
// module. `--conditions=react-server` also clears it but swaps in React's
// server build, which breaks next/navigation imports deeper in the chain.
const Module = require("node:module");
const path = require("node:path");

const emptyModule = path.join(__dirname, "server-only-empty.cjs");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return emptyModule;
  return resolve.call(this, request, ...rest);
};
