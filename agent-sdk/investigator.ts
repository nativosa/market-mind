// The investigator policy has exactly one source: the committed subagent and skill files. This module
// reads them at runtime and maps them onto an SDK AgentDefinition (main-thread agent) and a task prompt
// (the skill body with $ARGUMENTS substituted). Nothing here paraphrases or copies the policy.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const AGENT_NAME = "market-investigator";
export const POLICY_FILES = {
  agent: ".claude/agents/market-investigator.md",
  skill: ".claude/skills/investigate-market/SKILL.md",
  settings: ".claude/settings.json",
} as const;

/** Frontmatter keys that have no effect when the agent runs as the SDK main thread (recorded, not applied). */
export const IGNORED_FOR_MAIN_THREAD: Record<string, string> = {
  omitClaudeMd: "no effect on a main-thread agent (SDK AgentDefinition docs); isolation comes from settingSources [] and a temp cwd",
};

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export interface PolicyFile {
  frontmatter: Record<string, string>;
  body: string;
}

/** Split `---\nkey: value\n---\nbody`. Values are single-line scalars; quotes are stripped. */
export function parsePolicyFile(text: string, label: string): PolicyFile {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${label}: missing frontmatter`);
  const frontmatter: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`${label}: unsupported frontmatter line ${JSON.stringify(line)}`);
    frontmatter[kv[1]!] = kv[2]!.replace(/^"(.*)"$/, "$1");
  }
  return { frontmatter, body: m[2]! };
}

export interface Investigator {
  name: string;
  definition: AgentDefinition;
  tools: string[];
  ignoredFrontmatter: string[];
  skillBody: string;
  hashes: { agentSha256: string; skillSha256: string; settingsSha256: string };
  /** The task prompt: the skill body with $ARGUMENTS replaced. */
  renderPrompt(args: string): string;
}

export function loadInvestigator(root = REPO_ROOT): Investigator {
  const read = (p: string) => readFileSync(join(root, p), "utf8");
  const agentText = read(POLICY_FILES.agent);
  const skillText = read(POLICY_FILES.skill);
  const settingsText = read(POLICY_FILES.settings);
  const agent = parsePolicyFile(agentText, POLICY_FILES.agent);
  const skill = parsePolicyFile(skillText, POLICY_FILES.skill);
  const fm = agent.frontmatter;
  if (fm.name !== AGENT_NAME) throw new Error(`${POLICY_FILES.agent}: expected name ${AGENT_NAME}, found ${fm.name ?? "none"}`);
  if (skill.frontmatter.agent !== AGENT_NAME) throw new Error(`${POLICY_FILES.skill}: skill does not delegate to ${AGENT_NAME}`);
  if (!skill.body.includes("$ARGUMENTS")) throw new Error(`${POLICY_FILES.skill}: no $ARGUMENTS placeholder`);
  const tools = (fm.tools ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const maxTurns = fm.maxTurns === undefined ? undefined : Number(fm.maxTurns);
  if (maxTurns !== undefined && !(Number.isInteger(maxTurns) && maxTurns > 0)) throw new Error(`${POLICY_FILES.agent}: invalid maxTurns`);
  const permissionMode = fm.permissionMode;
  if (permissionMode !== undefined && permissionMode !== "dontAsk" && permissionMode !== "default") throw new Error(`${POLICY_FILES.agent}: unsupported permissionMode ${permissionMode}`);
  const definition: AgentDefinition = {
    description: fm.description ?? "",
    prompt: agent.body,
    tools,
    ...(fm.model ? { model: fm.model } : {}),
    ...(maxTurns ? { maxTurns } : {}),
    ...(permissionMode ? { permissionMode } : {}),
  };
  const known = new Set(["name", "description", "tools", "model", "maxTurns", "permissionMode"]);
  const ignoredFrontmatter = Object.keys(fm).filter((k) => !known.has(k)).sort();
  for (const k of ignoredFrontmatter) if (!(k in IGNORED_FOR_MAIN_THREAD)) throw new Error(`${POLICY_FILES.agent}: frontmatter key ${k} has no SDK mapping`);
  return {
    name: AGENT_NAME,
    definition,
    tools,
    ignoredFrontmatter,
    skillBody: skill.body,
    hashes: { agentSha256: sha256(agentText), skillSha256: sha256(skillText), settingsSha256: sha256(settingsText) },
    renderPrompt: (args: string) => skill.body.split("$ARGUMENTS").join(args),
  };
}
