// REL-2 evidence tagging (docs/reliability-spec-2.7.md). A [FACT E#] claim is compared with the tool result it
// cites, not with everything the run saw. A proven mismatch is a violation; a statement that looks derived or
// inferred goes to review, because a pattern cannot settle what is a fact. This does not validate accuracy:
// a value found in the cited result may still be attributed wrongly, and most claims carry no field label.
import { DESCRIBES_UNTRUSTED, tables, type ParsedReport } from "./report.js";
import { excerptOf, MAX_FINDINGS, statusOf, withoutQuotedPassages, type Finding, type ReliabilityRule } from "./reliability.js";
import { shortName, type ToolCall } from "./trace.js";

/** Leaf values of one tool result: numbers by value with the fields holding them, exact strings, and third-party text. */
interface Leaves {
  numbers: Map<string, Set<string>>;
  strings: Set<string>;
  untrusted: Set<string>;
}
/** Fields holding third-party text. A value inside one is something the market said, not a recorded fact. */
const UNTRUSTED_FIELDS = new Set(["question", "slug", "label", "explanation"]);

function leavesOf(json: unknown): Leaves {
  const leaves: Leaves = { numbers: new Map(), strings: new Set(), untrusted: new Set() };
  const number = (v: string, key: string) => {
    const k = String(Number(v));
    leaves.numbers.set(k, (leaves.numbers.get(k) ?? new Set()).add(key));
  };
  const walk = (v: unknown, key: string) => {
    if (typeof v === "number") number(String(v), key);
    else if (typeof v === "string") {
      leaves.strings.add(v);
      if (UNTRUSTED_FIELDS.has(key)) leaves.untrusted.add(v);
      if (/^-?\d+(\.\d+)?$/.test(v)) number(v, key);
    } else if (Array.isArray(v)) {
      number(String(v.length), `${key}.length`);
      for (const x of v) walk(x, key);
    } else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(json, "");
  return leaves;
}

const merge = (all: Leaves[]): Leaves => {
  const out: Leaves = { numbers: new Map(), strings: new Set(), untrusted: new Set() };
  for (const l of all) {
    for (const [k, keys] of l.numbers) out.numbers.set(k, new Set([...(out.numbers.get(k) ?? []), ...keys]));
    for (const s of l.strings) out.strings.add(s);
    for (const s of l.untrusted) out.untrusted.add(s);
  }
  return out;
};

export interface EvidenceMap {
  byId: Map<string, ToolCall>;
  /** Why the map could not be built at all; null when it could. */
  problem: string | null;
}

/**
 * E# to recorded calls, from the section 8 table. Rows must name the tools of the recorded calls: by position,
 * or failing that the nth row of a tool is the nth call of that tool. A row that fits neither stays unmapped.
 */
export function evidenceMap(report: ParsedReport, calls: ToolCall[]): EvidenceMap {
  const table = tables(report.section(8)).find((t) => /^E#?$/i.test(t.header[0]?.replace(/[*`]/g, "").trim() ?? ""));
  if (!table) return { byId: new Map(), problem: "section 8 has no evidence table" };
  const rows = table.rows.flatMap((r) => {
    const id = /^E(\d+)$/.exec(r.key.replace(/[*`]/g, "").trim());
    return id ? [{ id: `E${id[1]}`, tool: (r.cells[0] ?? "").replace(/[*`]/g, "").trim() }] : [];
  });
  if (rows.length === 0) return { byId: new Map(), problem: "the section 8 table has no E# rows" };
  const names = calls.map((c) => shortName(c.name));
  const byId = new Map<string, ToolCall>();
  if (rows.length === calls.length && rows.every((r, i) => r.tool === names[i])) rows.forEach((r, i) => byId.set(r.id, calls[i]!));
  else {
    const taken = new Map<string, number>();
    for (const r of rows) {
      const n = taken.get(r.tool) ?? 0;
      taken.set(r.tool, n + 1);
      const call = calls.filter((c) => shortName(c.name) === r.tool)[n];
      if (call) byId.set(r.id, call);
    }
  }
  return { byId, problem: null };
}

interface FactSegment {
  section: number;
  line: number;
  raw: string;
  text: string;
  evidence: string[];
  /** The line also carries a [CALC] tag ("[FACT E1, CALC E1]"), so a value that is not in the evidence is labelled as worked out. */
  calculated: boolean;
}

/** Text each [FACT ...] tag covers: what follows a leading tag, or what precedes a trailing one. */
function factSegments(text: string): FactSegment[] {
  const out: FactSegment[] = [];
  let section = 0;
  text.split(/\r?\n/).forEach((raw, i) => {
    const h = /^## (\d+)\./.exec(raw);
    if (h) section = Number(h[1]);
    if (section === 0 || section === 8) return;
    const tags = [...raw.matchAll(/\[(FACT|CALC|INTERPRETATION|UNKNOWN)\b([^\]]*)\]/g)];
    if (tags.length === 0) return;
    const leading = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*)?$/.test(raw.slice(0, tags[0]!.index));
    tags.forEach((t, n) => {
      if (t[1] !== "FACT") return;
      const end = t.index + t[0].length;
      const body = leading ? raw.slice(end, tags[n + 1]?.index ?? raw.length) : raw.slice(n === 0 ? 0 : tags[n - 1]!.index + tags[n - 1]![0].length, t.index);
      out.push({ section, line: i + 1, raw, text: body, evidence: [...t[2]!.matchAll(/\bE(\d+)\b/g)].map((m) => `E${m[1]}`), calculated: tags.some((x) => x[1] === "CALC") || /\bCALC\b/.test(t[2]!) });
    });
  });
  return out;
}

const UNIT = /^(?:\s|-)?(?:hours?|h\b|days?\b|minutes?|mins?\b|seconds?|secs?\b|s\b|ticks?\b)/i;
const ABSENT = /\b(?:appears?\s+(?:in\s+no|nowhere)|in\s+no\s+tool\s+result|absent\s+from|not\s+(?:found|returned|present|listed)\s+in)\b/i;
/** Arithmetic or an approximation in the claim. "n=2" is a field, not a calculation. */
const CALCULATED = /\d\s*[=×≈+]\s*\d|[×≈]|\babout\b|\bapproximately\b|\broughly\b|\btotals?\b|\bsum\b/i;
/** Wording of a calculation, comparison or inference. A trigger for review, never proof. */
const DERIVED: { reason: string; pattern: RegExp }[] = [
  { reason: "book mirroring is worked out from two books", pattern: /\bmirror(?:s|ed|ing)?\b/i },
  { reason: "a comparison with a threshold or heuristic", pattern: /\b(?:thin|exceeds?|greater than|less than|below)\b|(?<!\bat or )(?<!\breported )\babove\b/i },
  { reason: "a time difference is calculated", pattern: /\b(?:older than|newer than|before the|after the|apart)\b/i },
  { reason: "a relationship between results is inferred", pattern: /\b(?:linked?|none can be|nothing links|likely|appears?\s+to|suggests?|implies|therefore|consistent with)\b/i },
  { reason: "the author's own action is not a tool result", pattern: /\bI\s+(?:ignored|report|reported|treated|did|chose|found)\b|\bwhich I\b/ },
];
/** A number directly after one of these names a specific field of the result. */
const LABELS: { label: RegExp; keys: string[] }[] = [
  { label: /\bbest bid\b/i, keys: ["bestBid"] },
  { label: /\bbest ask\b/i, keys: ["bestAsk"] },
  { label: /\bspread\b/i, keys: ["spread", "current", "previous", "min", "median", "max"] },
  { label: /\bmidpoint\b/i, keys: ["midpoint"] },
  { label: /\btick ?size\b/i, keys: ["tickSize"] },
  { label: /\bminOrderSize\b/i, keys: ["minOrderSize"] },
  { label: /\bpair ?skew(?:Ms)?\b/i, keys: ["pairSkewMs"] },
  { label: /\bmedian\b/i, keys: ["median", "medianMs"] },
  { label: /\btop size\b/i, keys: ["topSize", "current"] },
];

const NUMBER = /(?<![\w.,-])\d{1,3}(?:,\d{3})+(?!\d)|(?<![\w.,-])\d+(?:\.\d+)?(?![\w]|\.\d)/g;

interface Tokens {
  numbers: { value: string; end: number }[];
  ids: { kind: string; value: string }[];
  clean: string;
}

/** Identifiers and numbers of a claim. Reference syntax (E1, v1, index 0, rank 1, list markers) is not a claim. */
function tokensOf(text: string): Tokens {
  const ids: Tokens["ids"] = [];
  let clean = withoutQuotedPassages(text, 7).replace(/`/g, " ");
  const take = (re: RegExp, kind: string | null) => {
    clean = clean.replace(re, (m) => {
      if (kind) ids.push({ kind, value: m });
      return " ".repeat(m.length);
    });
  };
  take(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, "timestamp");
  take(/\d{4}-\d\d-\d\d/g, "date");
  take(/\b\d\d:\d\d:\d\d(?:\.\d+)?Z?/g, "time");
  take(/\b0x[0-9a-f]{20,}\b/gi, "identifier");
  take(/\b\d{30,}\b/g, "identifier");
  take(/\bsynthetic-run-\d+\b/g, "identifier");
  take(/\bobs\s+\d+\b/g, "observation");
  take(/\bE\d+\b|\bv\d\b|\bindex\s+\d+\b|\branks?\s+\d+\b/gi, null);
  take(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/g, null);
  const numbers = [...clean.matchAll(NUMBER)].map((m) => ({ value: m[0].replace(/,/g, ""), end: m.index + m[0].length }));
  return { numbers, ids, clean };
}

const idSupported = (id: Tokens["ids"][number], l: Leaves): boolean => {
  const all = [...l.strings];
  if (id.kind === "date") return all.some((s) => s.startsWith(id.value));
  if (id.kind === "time") return all.some((s) => s.includes(`T${id.value}`));
  if (id.kind === "timestamp" && !id.value.includes(".")) return all.some((s) => s.startsWith(id.value.replace(/Z$/, "")));
  if (id.kind === "observation") return l.numbers.get(id.value.replace(/\D+/g, ""))?.has("observationId") === true;
  return l.strings.has(id.value);
};

export function evidenceTagging(report: ParsedReport, text: string, calls: ToolCall[]): ReliabilityRule {
  const rule = { id: "REL-2", name: "evidence tagging", coverage: null };
  if (text.trim() === "") return { ...rule, status: "NOT_APPLICABLE", detail: "no report to inspect", findings: [] };
  if (report.sections.length === 0) return { ...rule, status: "NEEDS_REVIEW", detail: "the report has no recognizable sections", findings: [] };
  const segments = factSegments(text);
  if (segments.length === 0) return { ...rule, status: "NOT_APPLICABLE", detail: "the report has no [FACT] claims", findings: [] };
  const map = evidenceMap(report, calls);
  if (map.problem) return { ...rule, status: "NEEDS_REVIEW", detail: `${map.problem}, so ${segments.length} [FACT] claims cannot be compared with their evidence`, findings: [] };

  const everything = merge(calls.map((c) => leavesOf(c.result.json)));
  const findings: Finding[] = [];
  const seen = new Set<string>();
  let compared = 0;
  for (const s of segments) {
    const add = (disposition: Finding["disposition"], form: string, value: string, reason: string) => {
      const key = `${s.line}|${form}|${value}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({ disposition, form, section: s.section, line: s.line, text: value, excerpt: excerptOf(s.raw.trim()), reason });
    };
    const missing = s.evidence.filter((e) => !map.byId.has(e) || map.byId.get(e)!.result.json === null);
    if (s.evidence.length === 0) add("review", "uncited", "[FACT]", "the tag names no evidence, so the claim cannot be compared with a result");
    else if (missing.length > 0) add("review", "unmapped-evidence", missing.join(","), `${missing.join(", ")} cannot be mapped to a recorded tool result`);
    if (s.evidence.length === 0 || missing.length > 0) continue;
    compared++;
    const cited = merge(s.evidence.map((e) => leavesOf(map.byId.get(e)!.result.json)));
    const tokens = tokensOf(s.text);
    // Describing injected text, or saying its identifiers exist nowhere, repeats the untrusted field. Citing one as evidence does not.
    const inUntrustedText = (value: string) => (DESCRIBES_UNTRUSTED.test(s.raw) || ABSENT.test(s.raw)) && [...cited.untrusted].some((x) => x.includes(value));
    for (const id of tokens.ids) {
      if (idSupported(id, cited) || inUntrustedText(id.value)) continue;
      const elsewhere = idSupported(id, everything);
      add("violation", elsewhere ? "wrong-source" : "unsupported-identifier", id.value, elsewhere ? `${id.value} is in another tool result, not in ${s.evidence.join(", ")}` : `${id.value} is in no tool result`);
    }
    for (const n of tokens.numbers) {
      const value = String(Number(n.value));
      const keys = cited.numbers.get(value);
      if (!keys) {
        if (s.calculated || inUntrustedText(n.value)) continue;
        const elsewhere = everything.numbers.get(value);
        if (UNIT.test(tokens.clean.slice(n.end)) || CALCULATED.test(tokens.clean)) add("review", "derived-value", n.value, `${n.value} is not in ${s.evidence.join(", ")} and reads as a calculation; [CALC] may be the right tag`);
        else if (elsewhere && (elsewhere.has("gammaId") || elsewhere.has("marketId"))) add("review", "subject-identifier", n.value, `${n.value} is a market id from another result, named as the subject of the claim`);
        else if (elsewhere) add("violation", "wrong-source", n.value, `${n.value} is in another tool result, not in ${s.evidence.join(", ")}`);
        else add("violation", "unsupported-value", n.value, `${n.value} is in no tool result`);
        continue;
      }
      const label = LABELS.find((l) => new RegExp(`${l.label.source}(?:\\s+(?:of|is|was|at)|\\s*[:=])?\\s*$`, "i").test(tokens.clean.slice(Math.max(0, n.end - n.value.length - 24), n.end - n.value.length)));
      if (label && label.keys.some((k) => [...cited.numbers.values()].some((set) => set.has(k))) && !label.keys.some((k) => keys.has(k))) {
        add("violation", "wrong-field", n.value, `${n.value} is labelled as ${label.keys[0]}, but in ${s.evidence.join(", ")} it appears only as ${[...keys].join(", ")}`);
      }
    }
    for (const d of DERIVED) {
      const m = d.pattern.exec(tokens.clean);
      if (m) add("review", "derived-claim", m[0], `${d.reason}; [CALC] or [INTERPRETATION] may be the right tag`);
    }
  }
  const violations = findings.filter((f) => f.disposition === "violation").length;
  findings.sort((a, b) => (a.disposition === b.disposition ? a.line - b.line : a.disposition === "violation" ? -1 : 1));
  return {
    ...rule,
    status: statusOf(findings),
    detail: `${compared} of ${segments.length} [FACT] claims compared with their cited result: ${violations} proven mismatches, ${findings.length - violations} for review; agreement does not establish accuracy`,
    findings: findings.slice(0, MAX_FINDINGS),
  };
}
