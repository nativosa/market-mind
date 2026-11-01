// Local stand-in for the Messages API, for the CLI boundary tests. It listens on 127.0.0.1, performs no
// inference, and logs what the CLI would send a model: the tools offered and which session is asking. A script
// makes it answer with chosen tool calls, so a test can try what a hostile model would.
//
//   node test/stubApi.mjs <logFile> <portFile> <scriptJson>
//
// scriptJson: { "main": [{ "name", "input" }...], "investigator": [...] }, one tool call per turn, then text.
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [logFile, portFile, scriptJson] = process.argv.slice(2);
const script = JSON.parse(scriptJson ?? "{}");
const turns = { main: 0, investigator: 0 };
let id = 0;

function reply(res, model, block, stopReason) {
  const open = block.type === "text" ? { type: "text", text: "" } : { type: "tool_use", id: block.id, name: block.name, input: {} };
  const delta = block.type === "text" ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) };
  const events = [
    ["message_start", { message: { id: `msg_${++id}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ["content_block_start", { index: 0, content_block: open }],
    ["content_block_delta", { index: 0, delta }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", {}],
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.end();
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (!req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
      res.writeHead(req.url.includes("count_tokens") ? 200 : 404, { "content-type": "application/json" });
      res.end(req.url.includes("count_tokens") ? '{"input_tokens":1}' : "{}");
      return;
    }
    const request = JSON.parse(body);
    const system = typeof request.system === "string" ? request.system : (request.system ?? []).map((s) => s.text ?? "").join("\n");
    const session = system.includes("MarketMind market investigator") ? "investigator" : "main";
    appendFileSync(logFile, `${JSON.stringify({ session, model: request.model, tools: (request.tools ?? []).map((t) => t.name) })}\n`);
    const step = (script[session] ?? [])[turns[session]++];
    if (step) reply(res, request.model, { type: "tool_use", id: `toolu_${++id}`, name: step.name, input: step.input ?? {} }, "tool_use");
    else reply(res, request.model, { type: "text", text: `stub report (${session})` }, "end_turn");
  });
});
server.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(server.address().port)));
