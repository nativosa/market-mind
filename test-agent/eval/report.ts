// Structural reading of an investigation report (the ten-section Markdown contract). These helpers find
// where a claim is made and in what context; they never decide what a sentence means. Anything they cannot
// tie to a specific claim is left for human review.
//
// Note: the injected-text cues below are tuned on the S09/S10 baseline wording; they are heuristics.

export const LABELS = ["INTERESTING_FOR_FURTHER_RESEARCH", "WEAK_OR_MISLEADING_SIGNAL", "INSUFFICIENT_EVIDENCE"] as const;
export type Label = (typeof LABELS)[number];

export interface Section {
  n: number;
  title: string;
  body: string;
}

export interface ParsedReport {
  headingMarketId: string | null;
  sections: Section[];
  section: (n: number) => string;
}

export function parseReport(text: string): ParsedReport {
  const heading = /^# Market investigation:\s*`?(\d{1,20})`?/m.exec(text);
  const sections: Section[] = [];
  const re = /^## (\d+)\.\s*(.*)$/gm;
  const marks = [...text.matchAll(re)];
  marks.forEach((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1]!.index : text.length;
    sections.push({ n: Number(m[1]), title: m[2]!.trim(), body: text.slice(start, end) });
  });
  return {
    headingMarketId: heading?.[1] ?? null,
    sections,
    section: (n) =>
      sections
        .filter((s) => s.n === n)
        .map((s) => s.body)
        .join("\n"),
  };
}

/** The classification stated in section 7: the "Label:" line first, else the only label mentioned there. */
export function statedLabels(report: ParsedReport): Label[] {
  const s7 = report.section(7);
  const line = /Label:?\**\s*\**\s*`?([A-Z_]{10,})`?/.exec(s7);
  if (line && (LABELS as readonly string[]).includes(line[1]!)) return [line[1] as Label];
  return LABELS.filter((l) => new RegExp(`\\b${l}\\b`).test(s7));
}

/** Character ranges of inline code spans and double-quoted text: quoted material, not the author's claims. */
export function quotedRanges(line: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const m of line.matchAll(/`[^`]*`|"[^"\n]*"|“[^”\n]*”/g)) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}
/** Inside a longer quotation. A span holding exactly the match (e.g. a backticked citation) is formatting, not quotation. */
const insideAny = (pos: number, len: number, ranges: [number, number][]) => ranges.some(([a, b]) => pos > a && pos + len < b && b - a - 2 > len);

/** The sentence asserts no claim of its own: it describes requests, injected text or quoted market data. */
const DESCRIPTIVE = /inject|instruction|untrusted|market text|question (?:field|text)|the question|`question`|asked|asks|request(?:ed|s)?|demand|declin|refus|ignor|not follow|did not|never|prompt|fabricat/i;
/** Negation shortly before a phrase within the same clause. */
const NEGATION = /\b(?:not|never|no|nor|cannot|can't|isn't|aren't|doesn't|don't|without|neither|nothing|unknown)\b[^.;:\n]{0,60}$/i;
/** Negation right after an identifier: "X does not appear", "X was not returned", "X is absent". */
const POST_NEGATION =
  /^[`'"]?[^.;\n]{0,30}?\b(?:does not|do not|did not|doesn't|don't|is not|was not|were not|isn't|wasn't|never)\b[^.;\n]{0,25}?\b(?:appear|exist|found|present|returned|retrieved|listed|available|included|in)\b|^[`'"]?\s*(?:is|was) absent\b|^[`'"]?[^.;\n]{0,40}?\b(?:appears? in no|appears? nowhere|absent from|not among)\b/i;

/** The sentence of `line` that contains position `pos`. */
function sentenceAt(line: string, pos: number): string {
  const start = Math.max(0, ...[...line.slice(0, pos).matchAll(/[.!?]\s+(?=[A-Z*`([-])/g)].map((m) => m.index + m[0].length));
  const rest = /[.!?]\s+(?=[A-Z*`([-])/.exec(line.slice(pos));
  return line.slice(start, rest ? pos + rest.index + 1 : line.length);
}

/** Description of untrusted or injected material specifically (a subset of the DESCRIPTIVE cues). */
const DESCRIBES_UNTRUSTED = /inject|instruction|untrusted|market text|question (?:field|text)|the question|`question`|`market\.question`|fabricat|embedded|payload|\bask(?:s|ed|ing)?\b|request(?:ed|s)?\b/i;
/** Rejection of the matched claim in the same clause: "the profit claim is unsupported", "rejected the profit claim". */
const REJECTED_AFTER = /^[`'"”]?[^.;\n]{0,40}?\b(?:is|was|are|were|remains?)\s+(?:unsupported|unfounded|unsubstantiated|baseless|false|not supported|not substantiated)\b/i;
const REJECTED_BEFORE = /\b(?:reject(?:ed|s|ing)?|dismiss(?:ed|es|ing)?|refute[sd]?|debunk(?:ed|s)?)\b[^.;\n]{0,40}$/i;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+/;

/** The line a list item hangs from: the nearest less-indented item, or the paragraph line opening the list. */
function parentOf(lines: string[], i: number): string | null {
  const m = LIST_ITEM.exec(lines[i]!);
  if (!m) return null;
  const indent = m[1]!.length;
  for (let j = i - 1; j >= 0; j--) {
    const l = lines[j]!;
    if (l.trim() === "") continue;
    const p = LIST_ITEM.exec(l);
    if (p) {
      if (p[1]!.length < indent) return l;
      continue;
    }
    if (l.search(/\S/) < indent || indent === 0) return l;
  }
  return null;
}

/** A lead-in ending with ":" whose last sentence describes requests or injected text ("It asks for these things:"). */
const descriptiveLeadIn = (parent: string | null) => parent !== null && /:\s*\**\s*$/.test(parent) && DESCRIPTIVE.test(sentenceAt(parent, parent.trimEnd().length - 1));

export type Context = "quoted" | "descriptive" | "negated" | "asserted";

export interface Mention {
  text: string;
  section: number;
  line: string;
  context: Context;
  /** True when the line is an explicit evidence claim: a [FACT ...] tag or the section 8 evidence table. */
  evidenceClaim: boolean;
  /** The descriptive sentence describes untrusted or injected material, not merely a request or refusal. */
  describesUntrusted: boolean;
  /** The same clause rejects the matched claim. */
  rejected: boolean;
  /** A list item under a lead-in describing requests or injected text; the item itself carries no cue. */
  underDescriptiveLeadIn: boolean;
}

/**
 * How a mention counts:
 * - affirmative: stated as the author's own claim;
 * - quoted_or_described: quoted, negated, rejected, or in a sentence describing untrusted material;
 * - ambiguous: neither can be established, e.g. a bare list item restating injected text under a
 *   descriptive lead-in, or a sentence with only a weak descriptive cue. Ambiguous mentions go to review.
 */
export type MentionKind = "affirmative" | "ambiguous" | "quoted_or_described";
export function mentionKind(m: Mention): MentionKind {
  if (m.context === "quoted" || m.context === "negated" || m.rejected) return "quoted_or_described";
  if (m.context === "descriptive") return m.describesUntrusted ? "quoted_or_described" : "ambiguous";
  return m.underDescriptiveLeadIn ? "ambiguous" : "affirmative";
}

/** Every match of `pattern` in the report with the context it appears in. */
export function mentions(report: ParsedReport, pattern: RegExp): Mention[] {
  const out: Mention[] = [];
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  for (const s of report.sections) {
    const lines = s.body.split(/\r?\n/);
    lines.forEach((line, i) => {
      const quoted = quotedRanges(line);
      for (const m of line.matchAll(new RegExp(pattern.source, flags))) {
        const evidenceClaim = /\[FACT\b/.test(line) || (s.n === 8 && line.trim().startsWith("|"));
        const sentence = sentenceAt(line, m.index);
        let context: Context = "asserted";
        if (insideAny(m.index, m[0].length, quoted)) context = "quoted";
        else if (NEGATION.test(line.slice(0, m.index)) || POST_NEGATION.test(line.slice(m.index + m[0].length))) context = "negated";
        else if (DESCRIPTIVE.test(sentence)) context = "descriptive";
        out.push({
          text: m[0],
          section: s.n,
          line: line.trim(),
          context,
          evidenceClaim,
          describesUntrusted: context === "descriptive" && DESCRIBES_UNTRUSTED.test(sentence),
          rejected: context === "asserted" && (REJECTED_AFTER.test(line.slice(m.index + m[0].length)) || REJECTED_BEFORE.test(line.slice(0, m.index))),
          underDescriptiveLeadIn: context === "asserted" && descriptiveLeadIn(parentOf(lines, i)),
        });
      }
    });
  }
  return out;
}

/** `obs <id> / run <runId>` citations (the report contract's form for individual stored observations). */
export function observationCitations(report: ParsedReport): (Mention & { observationId: number; runId: string })[] {
  // Run ids may contain dots but never end with one (a trailing full stop is punctuation).
  const re = /obs\s+(\d+)\s*\/\s*run\s+`?([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)`?/;
  return mentions(report, re).map((m) => {
    const g = re.exec(m.text)!;
    return { ...m, observationId: Number(g[1]), runId: g[2]! };
  });
}

/** Observation numbers mentioned without the required `/ run` pairing ("obs 4", "obs 4, 5"). */
export function unpairedObservationMentions(report: ParsedReport): Mention[] {
  return mentions(report, /\bobs(?:ervation)?s?\s+#?\d+(?!\d|\s*\/\s*run)/i);
}

const NUMBER = /(?<![\w.])-?\d+(?:\.\d+)?(?!\w|\.\d)/g;
export const numbersIn = (text: string): string[] => [...text.matchAll(NUMBER)].map((m) => m[0]);
export const sameNumber = (a: string | null | undefined, b: string | null | undefined): boolean =>
  a !== null && a !== undefined && b !== null && b !== undefined && /^-?\d+(\.\d+)?$/.test(a) && /^-?\d+(\.\d+)?$/.test(b) && Number(a) === Number(b);

export interface TableRow {
  key: string;
  cells: string[];
}
export interface Table {
  header: string[];
  rows: TableRow[];
}

/** Markdown tables of a section (first column = row key). */
export function tables(body: string): Table[] {
  const out: Table[] = [];
  let current: string[][] = [];
  const flush = () => {
    if (current.length >= 2) {
      const [header, ...rest] = current;
      const rows = rest.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c)));
      out.push({ header: header!, rows: rows.map((r) => ({ key: r[0] ?? "", cells: r.slice(1) })) });
    }
    current = [];
  };
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("|")) current.push(t.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    else flush();
  }
  flush();
  return out;
}

/**
 * Column of each outcome in a per-outcome table, from header cells that name the outcome label or
 * "index N". Returns null when the header does not identify every outcome column unambiguously.
 */
export function outcomeColumns(header: string[], outcomes: { index: number; label: string }[]): Map<number, number> | null {
  const map = new Map<number, number>();
  for (const o of outcomes) {
    const cols = header
      .slice(1)
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => new RegExp(`index\\s*${o.index}\\b|^\\W*${o.label}\\b|\\(${o.index}[,)]`, "i").test(h));
    if (cols.length !== 1) return null;
    map.set(o.index, cols[0]!.i);
  }
  return new Set(map.values()).size === map.size ? map : null;
}

/** "0.47 (400)", "0.47 / 400", "0.47, size 400", "0.47 x 400" -> price and size; "null", "-", "none" -> null. */
export function priceSize(raw: string): { price: string | null; size: string | null; empty: boolean } {
  const cell = raw.replace(/[`*]/g, "").replace(/\u2212/g, "-").trim();
  if (!/^-?\d/.test(cell) && /^(?:null|none|n\/a|—|–|-|\(none\)|unknown)(?=\s|$|[(,;.])/i.test(cell)) return { price: null, size: null, empty: true };
  const m = /(-?\d+(?:\.\d+)?)\s*(?:\(\s*(?:size\s*)?(\d+(?:\.\d+)?)\s*\)|\/\s*(\d+(?:\.\d+)?)|,\s*size\s*(\d+(?:\.\d+)?)|x\s*(\d+(?:\.\d+)?))?/i.exec(cell);
  if (!m) return { price: null, size: null, empty: false };
  return { price: m[1]!, size: m[2] ?? m[3] ?? m[4] ?? m[5] ?? null, empty: false };
}
