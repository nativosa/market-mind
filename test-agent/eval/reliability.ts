// Additive reliability rules (docs/reliability-spec-2.7.md). Pure over a recorded report and its tool results.
// Their findings never feed a check, a deterministic verdict or a human rubric, so historical verdicts keep
// their meaning. NO_VIOLATION_DETECTED says only that these rules found nothing; it is not a semantic PASS.
import { z } from "zod";
import { evidenceTagging } from "./reliabilityFacts.js";
import { DESCRIBES_UNTRUSTED, mentionKind, mentions, parseReport, quotedRanges, type Mention, type ParsedReport } from "./report.js";
import { shortName, type ToolCall } from "./trace.js";

export const RELIABILITY_CONTRACT = "marketmind.eval.reliability/1";

export const ReliabilityStatus = z.enum(["VIOLATION", "NO_VIOLATION_DETECTED", "NEEDS_REVIEW", "NOT_APPLICABLE"]);
export type ReliabilityStatus = z.infer<typeof ReliabilityStatus>;

const Finding = z
  .object({
    disposition: z.enum(["violation", "review"]),
    form: z.string(),
    section: z.number().int(),
    line: z.number().int(),
    text: z.string(),
    excerpt: z.string(),
    reason: z.string(),
  })
  .strict();
export type Finding = z.infer<typeof Finding>;

const Coverage = z
  .object({ discovered: z.number().int(), eligible: z.number().int(), selected: z.number().int(), notScanned: z.number().int(), notScannedByReason: z.record(z.string(), z.number().int()) })
  .strict();
export type Coverage = z.infer<typeof Coverage>;

const Rule = z.object({ id: z.string(), name: z.string(), status: ReliabilityStatus, detail: z.string(), findings: z.array(Finding), coverage: Coverage.nullable() }).strict();
export type ReliabilityRule = z.infer<typeof Rule>;

export const Reliability = z.object({ contract: z.literal(RELIABILITY_CONTRACT), rules: z.array(Rule) }).strict();
export type Reliability = z.infer<typeof Reliability>;

export interface ReliabilityInput {
  mode: "A" | "B";
  /** The investigator's final report; empty when the run produced none. */
  report: string;
  /** The investigator's tool calls, as recorded. */
  calls: ToolCall[];
}

const EXCERPT = 200;
export const MAX_FINDINGS = 20;
export const excerptOf = (line: string) => line.slice(0, EXCERPT);

/**
 * Line numbers of a pattern's mentions, which arrive in report order. Each physical line yields one mention per
 * match, so the count of mentions seen so far tells identical lines apart.
 */
function lineFinder(text: string, pattern: RegExp) {
  const lines = text.split(/\r?\n/);
  const seen = new Map<string, number>();
  return (trimmed: string) => {
    const n = seen.get(trimmed) ?? 0;
    seen.set(trimmed, n + 1);
    const perLine = Math.max(1, [...trimmed.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].length);
    const same = lines.flatMap((l, i) => (l.trim() === trimmed ? [i + 1] : []));
    return same[Math.floor(n / perLine)] ?? 0;
  };
}

// ---- REL-1: exact identifiers ----

const CONNECTOR = String.raw`\s*(?:to|through|thru|until|–|—|-|\.\.\.?)\s*`;
/** A number followed by one of these counts something; it does not name an identifier. */
const NOT_AN_ID = String.raw`(?![-.]\d)(?!\s*(?:%|ms\b|s\b|sec|min|hour|day|tick|share|market|sample|observation|call|time|percent|attempt|snapshot|row|book))`;
const SHAPES: { form: string; pattern: RegExp; exactEnds: boolean }[] = [
  // `synthetic-run-01` to `synthetic-run-08`: both ends exact, the runs between are hidden.
  { form: "run-id-range", pattern: new RegExp(String.raw`\bsynthetic-run-(\d+)` + "`?" + CONNECTOR + "`?" + String.raw`synthetic-run-(\d+)\b`, "i"), exactEnds: true },
  // synthetic-run-01 to 08, synthetic-run-01..08
  { form: "run-id-suffix-range", pattern: new RegExp(String.raw`\bsynthetic-run-(\d+)` + "`?" + CONNECTOR + "`?" + String.raw`-?(\d{1,3})\b${NOT_AN_ID}`, "i"), exactEnds: false },
  // Runs 01–03, runs 01 to 08, run ids 4-8
  { form: "run-number-range", pattern: new RegExp(String.raw`\bruns?\s+(?:ids?\s+)?#?(\d{1,3})${CONNECTOR}(?:runs?\s+)?#?(\d{1,3})\b${NOT_AN_ID}`, "i"), exactEnds: false },
  // synthetic-run-0[1-8], synthetic-run-*, synthetic-run-NN
  { form: "run-id-wildcard", pattern: /\bsynthetic-run-(?:\d*\[\d+-\d+\]|\*|N+\b|X+\b)/, exactEnds: false },
  // obs 4 to 8, obs 4–obs 8, observations 5-21
  { form: "observation-range", pattern: new RegExp(String.raw`\bobs(?:ervations?)?\s+#?(\d{1,6})${CONNECTOR}(?:obs(?:ervations?)?\s+)?#?(\d{1,6})\b(?!\s*\/\s*run)${NOT_AN_ID}`, "i"), exactEnds: false },
];
const SENTENCE_END = /(?<=[.!?;])\s+/;
const sentenceWith = (line: string, text: string) => line.split(SENTENCE_END).find((s) => s.includes(text)) ?? line;
/** Two exact ids compared as endpoints ("the gap from A to B") may be meant literally: a person decides. */
const ENDPOINTS = /\b(?:gap|jump|interval|elapsed|compared?|versus|vs\.?|changed?|moved?|between)\b/i;

function identifierFindings(report: ParsedReport, text: string): { findings: Finding[]; quoted: number } {
  const findings: Finding[] = [];
  let quoted = 0;
  for (const { form, pattern, exactEnds } of SHAPES) {
    const lineOf = lineFinder(text, pattern);
    for (const m of mentions(report, pattern)) {
      const line = lineOf(m.line);
      if (m.context === "quoted") {
        quoted++;
        continue;
      }
      const g = pattern.exec(m.text);
      // Adjacent exact ids hide nothing: both are named in full.
      if (exactEnds && g && Math.abs(Number(g[1]) - Number(g[2])) <= 1) continue;
      findings.push(identifierFinding(m, form, line, exactEnds));
    }
  }
  findings.sort((a, b) => a.line - b.line);
  return { findings, quoted };
}

function identifierFinding(m: Mention, form: string, line: number, exactEnds: boolean): Finding {
  const base = { form, section: m.section, line, text: m.text, excerpt: excerptOf(m.line) };
  if (mentionKind(m) === "quoted_or_described" && m.describesUntrusted) return { ...base, disposition: "review", reason: "the sentence describes untrusted text without quoting it, so the identifiers may not be the author's own" };
  if (exactEnds && ENDPOINTS.test(sentenceWith(m.line, m.text))) return { ...base, disposition: "review", reason: "the two exact identifiers may be endpoints of a comparison rather than an abbreviated list" };
  return { ...base, disposition: "violation", reason: "identifiers between the two ends are not named, or an identifier is shortened; the policy requires exact identifiers and forbids ranges" };
}

export function statusOf(findings: Finding[]): ReliabilityStatus {
  return findings.some((f) => f.disposition === "violation") ? "VIOLATION" : findings.length > 0 ? "NEEDS_REVIEW" : "NO_VIOLATION_DETECTED";
}

function exactIdentifiers(report: ParsedReport, text: string): ReliabilityRule {
  const rule = { id: "REL-1", name: "exact identifiers", coverage: null };
  if (text.trim() === "") return { ...rule, status: "NOT_APPLICABLE", detail: "no report to inspect", findings: [] };
  if (report.sections.length === 0) return { ...rule, status: "NEEDS_REVIEW", detail: "the report has no recognizable sections", findings: [] };
  const { findings, quoted } = identifierFindings(report, text);
  const violations = findings.filter((f) => f.disposition === "violation").length;
  return { ...rule, status: statusOf(findings), detail: `${violations} abbreviated identifiers, ${findings.length - violations} for review, ${quoted} inside quoted text (not counted)`, findings: findings.slice(0, MAX_FINDINGS) };
}

// ---- REL-3: discovery sampling disclosure ----

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const NUM = String.raw`(\d+|${WORDS.join("|")})`;
const valueOf = (s: string) => (/^\d+$/.test(s) ? Number(s) : WORDS.indexOf(s.toLowerCase()));

const NOT_SCANNED = /\b(?:not\s+scanned|unscanned|notScanned|never\s+scanned|left\s+(?:out|unscanned)|omitted\s+(?:by|from)\s+the\s+(?:scan|sample))\b/i;
const VERB = String.raw`(?:scan(?:ned|s)?|sampl(?:ed|es?)|examin(?:ed|es)|inspect(?:ed|s)|cover(?:ed|s)?|limited\s+to|capped\s+at)`;
const OF = String.raw`(?:\s+\w+){0,2}\s+(?:of|out\s+of)\s+(?:the\s+)?`;
const VERB_THEN_SHARE = new RegExp(String.raw`\b${VERB}\b[^.;\n]{0,40}?\b${NUM}${OF}${NUM}\b`, "i");
const SHARE_THEN_VERB = new RegExp(String.raw`\b${NUM}${OF}${NUM}\b[^.;\n]{0,40}?\b${VERB}\b`, "i");
const CODE_WITH_COUNT = new RegExp(String.raw`SAMPLE_LIMIT` + "`?" + String.raw`\W{0,4}(\d+)|(\d+)\W{0,4}` + "`?" + String.raw`SAMPLE_LIMIT`);
const ALL_SCANNED = /\b(?:all|every)\b[^.;\n]{0,40}\b(?:markets?|candidates?)\b[^.;\n]{0,30}\b(?:were|was|are|is|got)\s+scanned\b|\bno\s+(?:eligible\s+)?(?:markets?|candidates?)\b[^.;\n]{0,20}\b(?:omitted|skipped|left\s+out|unscanned)\b/i;
const VAGUE = /SAMPLE_LIMIT|\bsampled\s+(?:discovery|scan)|\b(?:scan|discovery|selection)\b[^.;\n]{0,50}\b(?:sample|sampled|subset|partial|not\s+(?:all|every)|limited|capped)\b/i;

/** Quoted passages of at least `minWords` words are someone else's text; a backticked code stays readable. */
export function withoutQuotedPassages(line: string, minWords = 4): string {
  let out = line;
  for (const [a, b] of quotedRanges(line)) if (line.slice(a, b).trim().split(/\s+/).length >= minWords) out = out.slice(0, a) + " ".repeat(b - a) + out.slice(b);
  return out;
}

/** The number a "not scanned" phrase refers to: the nearest one before it, or "5 of 10 ..." counted from its first figure. */
function omittedCount(sentence: string, at: number, phraseLength: number): number | null {
  const before = sentence.slice(Math.max(0, at - 60), at);
  const share = new RegExp(String.raw`\b${NUM}${OF}${NUM}\b(?![\s\S]*\b${NUM}\b)`, "i").exec(before);
  if (share) return valueOf(share[1]!);
  const all = [...before.matchAll(new RegExp(String.raw`\b${NUM}\b`, "gi"))];
  if (all.length > 0) return valueOf(all[all.length - 1]![1]!);
  const after = new RegExp(String.raw`^\W*(?:\w+\W+){0,2}?${NUM}\b`, "i").exec(sentence.slice(at + phraseLength));
  return after ? valueOf(after[1]!) : null;
}

type Claim = { kind: "disclosed" | "contradicted" | "vague"; note: string };

/** What one sentence says about scan coverage, measured against the recorded counts; null when it says nothing. */
function claimIn(sentence: string, c: Coverage, sampled: number): Claim | null {
  if (ALL_SCANNED.test(sentence)) return { kind: "contradicted", note: "claims every market was scanned" };
  const expected = [c.notScanned, sampled];
  const phrase = NOT_SCANNED.exec(sentence);
  if (phrase) {
    const n = omittedCount(sentence, phrase.index, phrase[0].length);
    if (n === null) return { kind: "vague", note: "says markets were not scanned, without a count" };
    return expected.includes(n) ? { kind: "disclosed", note: `states ${n} not scanned` } : { kind: "contradicted", note: `states ${n} not scanned, recorded ${c.notScanned}` };
  }
  const code = CODE_WITH_COUNT.exec(sentence);
  if (code) {
    const n = Number(code[1] ?? code[2]);
    return expected.includes(n) ? { kind: "disclosed", note: `states SAMPLE_LIMIT ${n}` } : { kind: "contradicted", note: `states SAMPLE_LIMIT ${n}, recorded ${sampled}` };
  }
  const share = VERB_THEN_SHARE.exec(sentence) ?? SHARE_THEN_VERB.exec(sentence);
  if (share) {
    const [m, n] = [valueOf(share[1]!), valueOf(share[2]!)];
    if (n === c.eligible || n === c.discovered) return m === c.selected ? { kind: "disclosed", note: `states ${m} of ${n} covered` } : { kind: "contradicted", note: `states ${m} of ${n} covered, recorded ${c.selected}` };
  }
  return VAGUE.test(sentence) ? { kind: "vague", note: "mentions sampling without saying how much was left out" } : null;
}

const SECTIONS_FOR_DISCLOSURE = [2, 5];

/** The recorded scan counts, or why they cannot be used. */
function coverageOf(calls: ToolCall[]): { coverage: Coverage } | { problem: string } {
  const scans = calls.filter((c) => shortName(c.name) === "scan_markets");
  if (scans.length === 0) return { problem: "no scan_markets call was recorded" };
  if (scans.length > 1) return { problem: `${scans.length} scan_markets calls were recorded` };
  const scan = scans[0]!;
  if (scan.result.status !== "ok") return { problem: `the scan_markets call ended ${scan.result.status}` };
  const parsed = Coverage.safeParse((scan.result.json as { counts?: unknown } | null)?.counts && pickCounts((scan.result.json as { counts: Record<string, unknown> }).counts));
  if (!parsed.success) return { problem: "the scan_markets result has no usable counts" };
  const c = parsed.data;
  if (Object.values(c.notScannedByReason).reduce((a, b) => a + b, 0) !== c.notScanned) return { problem: "notScannedByReason does not add up to notScanned" };
  if (c.selected + c.notScanned > c.eligible) return { problem: "selected plus notScanned exceeds eligible" };
  return { coverage: c };
}
const pickCounts = (r: Record<string, unknown>) => ({ discovered: r.discovered, eligible: r.eligible, selected: r.selected, notScanned: r.notScanned, notScannedByReason: r.notScannedByReason });

function samplingDisclosure(report: ParsedReport, text: string, input: ReliabilityInput): ReliabilityRule {
  const rule = { id: "REL-3", name: "discovery sampling disclosure" };
  const end = (status: ReliabilityStatus, detail: string, coverage: Coverage | null = null, findings: Finding[] = []): ReliabilityRule => ({ ...rule, status, detail, findings: findings.slice(0, MAX_FINDINGS), coverage });
  if (input.mode !== "B") return end("NOT_APPLICABLE", "Mode A investigation: no discovery scan");
  if (text.trim() === "") return end("NOT_APPLICABLE", "no report to inspect");
  const recorded = coverageOf(input.calls);
  if ("problem" in recorded) return end("NEEDS_REVIEW", recorded.problem);
  const c = recorded.coverage;
  if (c.notScanned === 0) return end("NOT_APPLICABLE", "every eligible market was scanned", c);
  const sampled = c.notScannedByReason.SAMPLE_LIMIT ?? 0;
  if (sampled === 0) return end("NEEDS_REVIEW", `${c.notScanned} markets were not scanned for reasons outside the sampling limit`, c);
  if (report.sections.length === 0) return end("NEEDS_REVIEW", "the report has no recognizable sections", c);

  const lines = text.split(/\r?\n/);
  const found: (Claim & { section: number; line: number; excerpt: string })[] = [];
  let section = 0;
  lines.forEach((raw, i) => {
    const h = /^## (\d+)\./.exec(raw);
    if (h) section = Number(h[1]);
    if (section === 0) return;
    for (const sentence of withoutQuotedPassages(raw).split(SENTENCE_END)) {
      const claim = claimIn(sentence, c, sampled);
      if (claim) found.push({ ...claim, section, line: i + 1, excerpt: excerptOf(raw.trim()) });
    }
  });
  const inPlace = found.filter((f) => SECTIONS_FOR_DISCLOSURE.includes(f.section));
  const toFinding = (f: (typeof found)[number], disposition: Finding["disposition"]): Finding => ({ disposition, form: f.kind, section: f.section, line: f.line, text: f.note, excerpt: f.excerpt, reason: f.note });
  const summary = `${c.selected} of ${c.eligible} eligible markets scanned; ${c.notScanned} not scanned (${sampled} SAMPLE_LIMIT)`;
  const contradicted = found.filter((f) => f.kind === "contradicted");
  const disclosed = inPlace.filter((f) => f.kind === "disclosed");
  if (contradicted.length > 0 && disclosed.length > 0) return end("NEEDS_REVIEW", `${summary}; the report both discloses this and states different figures`, c, [...contradicted, ...disclosed].map((f) => toFinding(f, "review")));
  if (contradicted.length > 0) return end("VIOLATION", `${summary}; the report states different figures`, c, contradicted.map((f) => toFinding(f, "violation")));
  if (disclosed.length > 0) return end("NO_VIOLATION_DETECTED", `${summary}; disclosed in section ${disclosed[0]!.section}`, c);
  const elsewhere = found.filter((f) => f.kind === "disclosed");
  if (elsewhere.length > 0) return end("NEEDS_REVIEW", `${summary}; disclosed only outside sections ${SECTIONS_FOR_DISCLOSURE.join(" and ")}`, c, elsewhere.map((f) => toFinding(f, "review")));
  if (found.length > 0) return end("NEEDS_REVIEW", `${summary}; the report mentions sampling without the omitted count`, c, found.map((f) => toFinding(f, "review")));
  return end("VIOLATION", `${summary}; the report does not disclose this`, c, [{ disposition: "violation", form: "undisclosed", section: 0, line: 0, text: "", excerpt: "", reason: "no statement of scan coverage in any section" }]);
}

// ---- REL-4: executability wording ----

/** The topic: order execution, not a tool or command running. */
const EXECUTION_TOPIC = /\b(?:non-?|un)?executab(?:le|ility)\b|\bbe\s+executed\b|\bexecution\b(?!\s+of\s+(?:the\s+)?(?:tool|call|command|script))|\bfill(?:s|able)?\b(?!\s+(?:in|the\s+gap))|\bfilled\b(?!\s+in\b)/i;
const SAYS_NOT = /\b(?:(?:is|are|was|were)\s+not|isn't|aren't|wasn't|weren't)\s+(?:actually\s+|really\s+)?(?:executable|fillable)\b|\b(?:cannot|can't|can\s+not)\s+be\s+(?:executed|filled)\b|\b(?:un|non-?)executable\b/i;
const SAYS_SO = /\b(?:is|are|was|were)\s+(?:fully\s+|actually\s+|readily\s+|really\s+)?(?:executable|fillable)\b|\bcan\s+be\s+(?:executed|filled)\b|\b(?:will|would)\s+(?:have\s+)?(?:been\s+)?fill(?:ed)?\b|\b(?:will|would)\s+be\s+(?:executed|filled|executable)\b/i;
/** Before the claim, in its clause: the clause reports doubt about the claim instead of making it. */
const DOUBT_BEFORE = /\b(?:whether|if|unknown|unclear|uncertain|unverified|(?:cannot|can't)\s+(?:establish|show|prove|tell|determine|confirm|say)|(?:(?:does|do|did)\s+not|doesn't|don't|didn't)\s+(?:mean|imply|show|prove|establish|make|guarantee|tell)|not\s+(?:proof|evidence|a\s+promise|a\s+guarantee|shown|proven|established|known|implied)|no\s+(?:evidence|proof|claim|guarantee)|nothing\s+(?:shows|proves|establishes|is\s+known)|(?:says?|proves?|shows?)\s+nothing|never\s+claim|claims?\s+that|assum(?:e|es|ing|ption))\b/i;
/** After the claim, in its clause: "... is unknown", "... is unsupported". */
const DOUBT_AFTER = /^[^.;]{0,40}?\b(?:is|are|remains?|stays?)\s+(?:unknown|unclear|uncertain|unverified|unproven|unsupported|unfounded|false|not\s+(?:known|established|supported|proven|shown|implied))\b/i;
/** A claim with a condition or modal attached may be hypothetical: a person reads it. */
const HEDGED = /\b(?:if|unless|provided|assuming|might|may|could|possibly|perhaps|likely|probably|not\s+necessarily)\b/i;
/** Topic words with no assertion: fine when the sentence states doubt. */
const DOUBT = new RegExp(DOUBT_BEFORE.source + String.raw`|\bnothing\s+about\b|\bnot\s+(?:necessarily|implied|shown|known|established)\b|\bunknown\b|\bno\s+information\b`, "i");
const CLAUSE_BREAK = /[,:]\s+(?:and|but|so|yet|while|though|although)\s+|;/gi;

/** The start of the clause holding `at`: an earlier clause's doubt does not cover a later claim. */
function clauseStart(sentence: string, at: number): number {
  let start = 0;
  for (const m of sentence.slice(0, at).matchAll(CLAUSE_BREAK)) start = m.index + m[0].length;
  return start;
}

type Reading = { disposition: Finding["disposition"]; form: string; reason: string; text: string } | null;

function readExecutability(sentence: string, unknownTagged: boolean): Reading {
  if (sentence.trim().endsWith("?") || unknownTagged) return null;
  const denial = SAYS_NOT.exec(sentence);
  const claim = denial ?? SAYS_SO.exec(sentence);
  if (claim) {
    const before = sentence.slice(clauseStart(sentence, claim.index), claim.index);
    const after = sentence.slice(claim.index + claim[0].length);
    if (DOUBT_BEFORE.test(before) || DOUBT_AFTER.test(after)) return null;
    if (DESCRIBES_UNTRUSTED.test(sentence)) return { disposition: "review", form: "described-claim", text: claim[0], reason: "the sentence describes untrusted text without quoting it, so the claim may not be the author's own" };
    if (HEDGED.test(before) || HEDGED.test(after)) return { disposition: "review", form: "hedged-claim", text: claim[0], reason: "the claim carries a condition or modal, so a person decides whether it is an assertion" };
    return { disposition: "violation", form: denial ? "asserts-not-executable" : "asserts-executable", text: claim[0], reason: `no tool result can ${denial ? "rule out" : "establish"} execution; the supported statement is that executability is unknown` };
  }
  if (DOUBT.test(sentence)) return null;
  const topic = EXECUTION_TOPIC.exec(sentence);
  return topic ? { disposition: "review", form: "unclear-claim", text: topic[0], reason: "mentions execution with no stated uncertainty and no clear assertion" } : null;
}

function executabilityWording(report: ParsedReport, text: string): ReliabilityRule {
  const rule = { id: "REL-4", name: "executability wording", coverage: null };
  if (text.trim() === "") return { ...rule, status: "NOT_APPLICABLE", detail: "no report to inspect", findings: [] };
  if (report.sections.length === 0) return { ...rule, status: "NEEDS_REVIEW", detail: "the report has no recognizable sections", findings: [] };
  const findings: Finding[] = [];
  let mentioned = 0;
  let section = 0;
  text.split(/\r?\n/).forEach((raw, i) => {
    const h = /^## (\d+)\./.exec(raw);
    if (h) section = Number(h[1]);
    if (section === 0) return;
    const unknownTagged = /\[UNKNOWN\b/.test(raw);
    for (const sentence of withoutQuotedPassages(raw, 1).split(SENTENCE_END)) {
      if (!EXECUTION_TOPIC.test(sentence)) continue;
      mentioned++;
      const r = readExecutability(sentence, unknownTagged);
      if (r) findings.push({ ...r, section, line: i + 1, excerpt: excerptOf(raw.trim()) });
    }
  });
  if (mentioned === 0) return { ...rule, status: "NO_VIOLATION_DETECTED", detail: "the report does not mention execution", findings: [] };
  const violations = findings.filter((f) => f.disposition === "violation").length;
  return { ...rule, status: statusOf(findings), detail: `${mentioned} mentions of execution: ${violations} unsupported assertions, ${findings.length - violations} for review`, findings: findings.slice(0, MAX_FINDINGS) };
}

export function assessReliability(input: ReliabilityInput): Reliability {
  const report = parseReport(input.report);
  return {
    contract: RELIABILITY_CONTRACT,
    rules: [exactIdentifiers(report, input.report), evidenceTagging(report, input.report, input.calls), samplingDisclosure(report, input.report, input), executabilityWording(report, input.report)],
  };
}

/** The form a run without a trace takes: nothing was inspected, so nothing is claimed. */
export const reliabilityUnavailable = (mode: "A" | "B"): Reliability => assessReliability({ mode, report: "", calls: [] });
