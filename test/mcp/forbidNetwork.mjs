// Preloaded into spawned MCP server processes (NODE_OPTIONS=--import): any network attempt fails and is
// reported on stderr, so a test can prove that a tool made no request, or that every attempt was blocked.
globalThis.fetch = (input) => {
  process.stderr.write(`[forbidNetwork] blocked ${String(input).split("?")[0]}\n`);
  return Promise.reject(new TypeError("network access is forbidden in this test process"));
};
