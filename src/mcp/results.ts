import type { CallToolResult } from "@modelcontextprotocol/server";
import { CONTRACT, MCP_LIMITS, type ErrorOutput } from "../research/contracts.js";
import { describeError } from "../research/envelope.js";

/**
 * Successful result. Claude Code hands the model `structuredContent` (verified with Claude Code
 * 2.1.302), so the full payload lives there; the text block is a short fallback summary for clients
 * that only show text, never a second copy of the payload.
 */
export function success(structured: Record<string, unknown>, summary: string): CallToolResult {
  return {
    content: [{ type: "text", text: `${summary}\nFull result: structuredContent (contract ${String(structured.contract)}).` }],
    structuredContent: structured,
  };
}

export const resultSize = (result: CallToolResult): number => JSON.stringify(result).length;

/**
 * Build a result within the size bound by shrinking collection caps deterministically (`shrink`
 * returns the next smaller caps, or null at the floor). Every view reports what was cut.
 */
export function fitted<Caps>(caps: Caps, build: (caps: Caps) => CallToolResult, shrink: (caps: Caps) => Caps | null, maxChars: number): CallToolResult {
  let current: Caps | null = caps;
  while (current !== null) {
    const result = build(current);
    if (resultSize(result) <= maxChars) return result;
    current = shrink(current);
  }
  // Never cut JSON mid-structure: an internal error (logged by the tool handler) instead.
  throw new Error("result exceeds the response size bound at minimum caps");
}

/**
 * Tool error (`isError: true`). The error object travels as JSON text only: Claude Code shows the
 * model the text block of an error result, and `structuredContent` would have to match the tool's
 * success output schema, which strict clients (e.g. the MCP Inspector) enforce even on errors.
 */
export function failure(error: unknown, log: (line: string) => void): CallToolResult {
  const described = describeError(error);
  if (described.category === "internal_error") log(`internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  const body: ErrorOutput = { contract: CONTRACT.error, error: described };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] };
}

/** The error category of a `failure` result, for logging. */
export function categoryOf(result: CallToolResult): string {
  const first = result.content[0];
  try {
    return first?.type === "text" ? ((JSON.parse(first.text) as Partial<ErrorOutput>).error?.category ?? "") : "";
  } catch {
    return "";
  }
}

export const MAX_RESULT_CHARS = MCP_LIMITS.maxResultChars;
