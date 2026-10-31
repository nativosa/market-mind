// Redaction for everything the application prints or writes: the API key value, anything shaped like an
// Anthropic key or bearer token, session identifiers, and absolute user-home or temp paths.
import { homedir, tmpdir } from "node:os";

const KEY_SHAPES = [/sk-ant-[A-Za-z0-9_-]{8,}/g, /\b(?:Bearer|x-api-key:)\s+[A-Za-z0-9._~+/=-]{12,}/gi];
const SESSION_KEYS = new Set(["session_id", "sessionId", "uuid", "transcript_path", "cwd", "request_id", "user_message_uuid", "agent_id"]);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class Redactor {
  private readonly patterns: { re: RegExp; label: string }[] = [];

  constructor(secrets: string[], paths: { home: string; temp: string } = { home: homedir(), temp: tmpdir() }) {
    for (const s of secrets.filter((x) => x.length >= 8)) this.patterns.push({ re: new RegExp(escape(s), "g"), label: "<redacted:key>" });
    // Longest first, so a temp dir inside the home dir is replaced as <temp>; native, slash and JSON-escaped forms.
    const ps: [string, string][] = [
      [paths.temp, "<temp>"],
      [paths.home, "<home>"],
    ];
    for (const [p, label] of ps.filter(([p]) => p.length > 3).sort((a, b) => b[0].length - a[0].length)) {
      for (const form of new Set([p, p.replace(/\\/g, "/"), JSON.stringify(p).slice(1, -1)])) this.patterns.push({ re: new RegExp(escape(form), "gi"), label });
    }
  }

  text(s: string): string {
    let out = s;
    for (const { re, label } of this.patterns) out = out.replace(re, label);
    for (const re of KEY_SHAPES) out = out.replace(re, "<redacted:key>");
    return out;
  }

  /** Deep copy with strings redacted and session/path fields masked. */
  value<T>(v: T): T {
    const walk = (x: unknown, key?: string): unknown => {
      if (typeof x === "string") return key && SESSION_KEYS.has(key) ? "<redacted>" : this.text(x);
      if (Array.isArray(x)) return x.map((y) => walk(y));
      if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y, k)]));
      return x;
    };
    return walk(v) as T;
  }
}
