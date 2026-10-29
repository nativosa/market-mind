import { existsSync, readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { connect, type Connected } from "../mcpFixtures.js";

// Stage 2.4: static checks of the investigation Skill, the restricted Subagent and the project
// permissions. No model is called; these pin the configuration that real-agent runs rely on.

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const AGENT = ".claude/agents/market-investigator.md";
const SKILL = ".claude/skills/investigate-market/SKILL.md";
const SETTINGS = ".claude/settings.json";

/** Frontmatter restricted to flat `key: value` lines (anything else fails the test). */
function parse(path: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(read(path));
  if (!match) throw new Error(`${path}: no frontmatter at line 1`);
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z-]+): (.+)$/.exec(line);
    if (!kv) throw new Error(`${path}: frontmatter line is not flat key: value: ${JSON.stringify(line)}`);
    expect(meta, `${path}: duplicate key ${kv[1]}`).not.toHaveProperty(kv[1]!);
    meta[kv[1]!] = kv[2]!.replace(/^"(.*)"$/, "$1");
  }
  return { meta, body: match[2]! };
}

const TOOL_NAMES = ["scan_markets", "inspect_market", "list_collection_runs", "get_market_history", "get_observation_details"];
const EXPECTED_TOOLS = TOOL_NAMES.map((t) => `mcp__marketmind__${t}`).sort();
const FORBIDDEN_TOOL = /^(Bash|PowerShell|Write|Edit|NotebookEdit|Read|Glob|Grep|LSP|WebFetch|WebSearch|Agent|Task|Skill|ToolSearch|SendMessage|Monitor|Artifact)\b|^mcp__(?!marketmind__)/;

const agent = parse(AGENT);
const skill = parse(SKILL);
const agentTools = agent.meta.tools!.split(",").map((t) => t.trim());

describe("market-investigator subagent", () => {
  it("has exactly the approved frontmatter", () => {
    expect(Object.keys(agent.meta).sort()).toEqual(["description", "maxTurns", "model", "name", "omitClaudeMd", "permissionMode", "tools"]);
    expect(agent.meta.name).toBe("market-investigator");
    expect(agent.meta.model).toBe("sonnet");
    expect(agent.meta.permissionMode).toBe("dontAsk");
    expect(agent.meta.omitClaudeMd).toBe("true");
    expect(agent.meta.maxTurns).toMatch(/^\d+$/);
    expect(Number(agent.meta.maxTurns)).toBeGreaterThan(0);
    expect(Number(agent.meta.maxTurns)).toBeLessThanOrEqual(15);
  });

  it("allows only the five MarketMind tools, listed explicitly", () => {
    expect([...agentTools].sort()).toEqual(EXPECTED_TOOLS);
    expect(agentTools.filter((t) => FORBIDDEN_TOOL.test(t) || t.includes("*"))).toEqual([]);
  });

  it("has no persistent memory, extra servers, hooks, skills, isolation or background mode", () => {
    for (const key of ["memory", "mcpServers", "hooks", "skills", "isolation", "background", "disallowedTools", "initialPrompt"]) expect(agent.meta).not.toHaveProperty(key);
    expect(existsSync(new URL(".claude/agent-memory", root))).toBe(false);
    expect(existsSync(new URL(".claude/agent-memory-local", root))).toBe(false);
  });

  it("states the report contract, claim tags and research classifications", () => {
    for (let n = 1; n <= 10; n++) expect(agent.body).toMatch(new RegExp(`^## ${n}\\. `, "m"));
    for (const tag of ["[FACT E#]", "[CALC E#]", "[INTERPRETATION]", "[UNKNOWN]"]) expect(agent.body).toContain(tag);
    for (const label of ["INTERESTING_FOR_FURTHER_RESEARCH", "WEAK_OR_MISLEADING_SIGNAL", "INSUFFICIENT_EVIDENCE"]) expect(agent.body).toContain(label);
    for (const rule of ["untrustedTextFields", "includeSynthetic", "not a trading recommendation", "provisional research heuristics", "obs <observationId> / run <runId>", "persistence between observations is unknown", 'label them "examples"']) {
      expect(agent.body).toContain(rule);
    }
  });
});

describe("investigate-market skill", () => {
  it("is manual-only and forks into the investigator", () => {
    expect(Object.keys(skill.meta).sort()).toEqual(["agent", "argument-hint", "background", "context", "description", "disable-model-invocation", "name"]);
    expect(skill.meta).toMatchObject({ name: "investigate-market", "disable-model-invocation": "true", context: "fork", agent: agent.meta.name, background: "false" });
    expect(skill.meta["argument-hint"]).toBe("<gammaId> [objective...] | discover [v1|v2] [objective...]");
  });

  it("passes its arguments and contains no shell injection or tool grants", () => {
    expect(skill.body).toContain("$ARGUMENTS");
    expect(skill.body).not.toMatch(/(^|\s)!`|^```!/m);
    expect(skill.meta).not.toHaveProperty("allowed-tools");
    expect(skill.meta).not.toHaveProperty("shell");
    expect(read(SKILL).split("\n").length).toBeLessThan(500);
    expect(readdirSync(new URL(".claude/skills/investigate-market/", root))).toEqual(["SKILL.md"]);
  });
});

describe("project permissions and MCP wiring", () => {
  let c: Connected | undefined;
  afterEach(async () => {
    await c?.close();
    c = undefined;
  });

  it("settings.json only allows the five MarketMind tools", () => {
    const settings = JSON.parse(read(SETTINGS)) as { permissions: { allow: string[] } };
    expect(Object.keys(settings)).toEqual(["permissions"]);
    expect(Object.keys(settings.permissions)).toEqual(["allow"]);
    expect([...settings.permissions.allow].sort()).toEqual(EXPECTED_TOOLS);
  });

  it("configured names match the tools the real server registers", async () => {
    c = await connect();
    const served = c.tools.map((t) => `mcp__marketmind__${t.name}`).sort();
    expect(served).toEqual(EXPECTED_TOOLS);
    const settings = JSON.parse(read(SETTINGS)) as { permissions: { allow: string[] } };
    expect([...settings.permissions.allow].sort()).toEqual(served);
    expect([...agentTools].sort()).toEqual(served);
  });

  it(".mcp.json names the server marketmind and local settings stay out of Git", () => {
    expect(Object.keys((JSON.parse(read(".mcp.json")) as { mcpServers: object }).mcpServers)).toEqual(["marketmind"]);
    expect(read(".gitignore").split(/\r?\n/)).toContain(".claude/settings.local.json");
  });
});
