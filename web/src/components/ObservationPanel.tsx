import type { ApiError, ObservationDetails } from "../api";
import { barScale, formatMs, formatShares, formatTimestamp, issueText, orUnknown, PAIR_SKEW_WARNING_MS, QUALITY_TEXT, SIZE_UNIT, STATE_TEXT } from "../book";
import { formatFlag, formatVolume, NOT_REPORTED } from "../format";
import { ACCOUNTING_TEXT, RUN_STATUS_TEXT } from "../history";
import { historyHash, type HistoryRoute } from "../route";
import { LadderSide } from "./BookComparison";
import { ResourceState } from "./ResourceState";
import { SourceChip } from "./StoredTables";
import styles from "./ObservationPanel.module.css";

export const OBSERVATION_HEADING_ID = "observation-heading";

type Book = ObservationDetails["books"][number];
type MetricsRow = ObservationDetails["metrics"][number];

const BASIS_TEXT: Record<ObservationDetails["observation"]["availabilityBasis"], string> = {
  paired_books: "when the second of the two books arrived",
  single_book: "when the only received book arrived",
  association: "when the token pairing was received",
  discovery: "when the market listing was received",
};

const PAIRING_TEXT: Record<ObservationDetails["observation"]["pairing"], string> = {
  paired: "Both outcome books received",
  incomplete: "Only one outcome book received",
  none: "No outcome book received",
};

const ORDER_TEXT: Record<Book["levels"]["order"], string> = {
  wire_order: "in the order Polymarket sent them, not re-sorted",
  aggregated_best_first: "best price first, same-price orders added together",
};

function Fact({ term, children, mono = false }: { term: string; children: React.ReactNode; mono?: boolean }) {
  const unknown = children === NOT_REPORTED;
  return (
    <>
      <dt>{term}</dt>
      <dd className={unknown ? styles.unknown : mono ? "mono" : undefined}>{children}</dd>
    </>
  );
}

const time = (iso: string | null) => formatTimestamp(iso);
const codes = (list: readonly string[]) => (list.length === 0 ? "None" : list.join(", "));

export interface ObservationPanelProps {
  route: Extract<HistoryRoute, { page: "market" }>;
  data: ObservationDetails | null;
  loading: boolean;
  error: ApiError | null;
  now: number;
  /** The analytics version the history uses (its metrics row is marked). */
  analyticsVersion: number | null;
  onRetry: () => void;
  onClose: () => void;
}

/**
 * One stored observation exactly as recorded: identities, timings, both books with their levels in
 * the order received, quality issues, pairing, request log and every stored metrics version. Read
 * from the local database only; selecting an observation never asks Polymarket for anything.
 */
export function ObservationPanel({ route, data, loading, error, now, analyticsVersion, onRetry, onClose }: ObservationPanelProps) {
  return (
    <aside className={styles.panel} aria-labelledby={OBSERVATION_HEADING_ID} aria-busy={loading}>
      <div className={styles.top}>
        <h3 id={OBSERVATION_HEADING_ID} className={styles.heading} tabIndex={-1}>
          Observation #{route.observationId}
        </h3>
        <button type="button" onClick={onClose}>
          Close observation
        </button>
      </div>
      <p className={styles.note}>Stored evidence exactly as recorded by collect. Nothing here is recalculated or fetched from Polymarket.</p>
      {data === null || error !== null ? (
        <ResourceState loading={loading} error={error} now={now} label="this observation" onRetry={onRetry} />
      ) : (
        <Evidence details={data} route={route} analyticsVersion={analyticsVersion} />
      )}
    </aside>
  );
}

function Evidence({ details: d, route, analyticsVersion }: { details: ObservationDetails; route: ObservationPanelProps["route"]; analyticsVersion: number | null }) {
  const o = d.observation;
  const otherMarket = o.gammaId !== route.marketId;
  const skewWarn = o.pairSkewMs !== null && o.pairSkewMs > PAIR_SKEW_WARNING_MS;
  return (
    <>
      {otherMarket && (
        <p className={styles.warning} role="note">
          This observation belongs to market {o.gammaId}, not market {route.marketId}.{" "}
          <a href={historyHash({ ...route, marketId: o.gammaId })}>Open it with its own market</a>.
        </p>
      )}
      {d.run.sourceType === "synthetic" && (
        <p className={styles.warning} role="note">
          Synthetic observation: test or demonstration data, not market evidence.
        </p>
      )}
      <section aria-label="Observation and run">
        <h4 className={styles.subheading}>Observation and run</h4>
        <dl className={styles.facts}>
          <Fact term="Observation ID" mono>
            {o.observationId}
          </Fact>
          <Fact term="Available at" mono>
            {time(o.availableAt)}
          </Fact>
          <Fact term="Availability basis">{BASIS_TEXT[o.availabilityBasis]}</Fact>
          <Fact term="Saved to the database at" mono>
            {time(o.persistedAt)}
          </Fact>
          <Fact term="Source">
            <SourceChip sourceType={d.run.sourceType} />
          </Fact>
          <Fact term="Run ID" mono>
            {d.run.runId}
          </Fact>
          <Fact term="Run started" mono>
            {time(d.run.startedAt)}
          </Fact>
          <Fact term="Run outcome">
            {d.runOutcome === null
              ? "Not finished (or finished after the time asked for)"
              : `${RUN_STATUS_TEXT[d.runOutcome.status]} · ${ACCOUNTING_TEXT[d.runOutcome.accounting]}`}
          </Fact>
          {d.runOutcome !== null && (
            <Fact term="Run finished" mono>
              {time(d.runOutcome.finishedAt)}
            </Fact>
          )}
          {d.runOutcome !== null && d.runOutcome.recoveredReason !== null && <Fact term="Recovered">{d.runOutcome.recoveredReason}</Fact>}
          <Fact term="Collected by">
            MarketMind {d.run.appVersion}
            {d.run.buildId === null ? "" : ` (build ${d.run.buildId})`} · schema v{d.run.schemaVersion} · analytics v{d.run.analyticsVersion} · {d.run.protocolVersion.toUpperCase()}
          </Fact>
        </dl>
      </section>

      <section aria-label="Market as observed">
        <h4 className={styles.subheading}>Market as observed</h4>
        <dl className={styles.facts}>
          <Fact term="Question">{o.question}</Fact>
          <Fact term="Market ID" mono>
            {o.gammaId}
          </Fact>
          <Fact term="Condition ID" mono>
            {o.conditionId}
          </Fact>
          <Fact term="Outcomes">{o.outcomeLabels.map((label, i) => `${i + 1}: ${label}`).join(" · ")}</Fact>
          <Fact term="Status">
            {o.closed ? "Closed" : o.active ? "Active" : "Inactive"} · accepting orders {formatFlag(o.acceptingOrders).toLowerCase()} · order book{" "}
            {formatFlag(o.enableOrderBook, "on", "off").toLowerCase()} · neg-risk {formatFlag(o.negRisk).toLowerCase()}
          </Fact>
          <Fact term="Ends" mono>
            {o.endDate ?? NOT_REPORTED}
          </Fact>
          <Fact term="Gamma 24h volume (not liquidity)">{formatVolume(o.gammaVolume24hr)}</Fact>
          <Fact term="Listing position">{o.discoveryPosition + 1}</Fact>
          <Fact term="Scan result">
            {o.bucket} · reasons {codes(o.reasonCodes)} · warnings {codes(o.warningCodes)}
          </Fact>
        </dl>
      </section>

      <section aria-label="Pairing">
        <h4 className={styles.subheading}>Pairing</h4>
        <dl className={styles.facts}>
          <Fact term="Books">{PAIRING_TEXT[o.pairing]}</Fact>
          <Fact term="Token pairing">{o.association === "confirmed" ? "Confirmed from Polymarket's CLOB market record" : o.association.replace("_", " ")}</Fact>
          <Fact term="Gap between the two book responses">
            {o.pairSkewMs === null ? NOT_REPORTED : `${formatMs(o.pairSkewMs)}${skewWarn ? ` (more than ${formatMs(PAIR_SKEW_WARNING_MS)})` : ""}`}
          </Fact>
        </dl>
        <p className={styles.note}>The books are separate requests made one after another, not an atomic snapshot.</p>
      </section>

      <section aria-label="Order books">
        <h4 className={styles.subheading}>Order books ({d.books.length} stored)</h4>
        <p className={styles.note}>
          Sizes are {SIZE_UNIT} resting at one instant: not dollars, and not a promise that an order would fill. Levels are shown exactly as stored, up to{" "}
          {d.appliedLimits.levels} per side.
        </p>
        {d.books.length === 0 && <p className={styles.unknown}>No book was received for this observation.</p>}
        {d.books.map((b) => (
          <StoredBook key={b.outcomeIndex} book={b} />
        ))}
      </section>

      <section aria-label="Stored metrics">
        <h4 className={styles.subheading}>Stored metrics ({d.metrics.length})</h4>
        <p className={styles.note}>
          One row per analytics version, each a separate derivation from the books above. &quot;At collection&quot; rows were computed when the observation was stored;
          recomputed rows came later from the same evidence.
        </p>
        {d.metrics.length === 0 && <p className={styles.unknown}>No metrics are stored: they need two valid books.</p>}
        {d.metrics.map((m) => (
          <MetricsCard key={m.analyticsVersion} metrics={m} labels={o.outcomeLabels} inUse={m.analyticsVersion === analyticsVersion} />
        ))}
      </section>

      <section aria-label="Requests">
        <h4 className={styles.subheading}>Requests made during collection ({d.requests.items.length})</h4>
        {d.requests.withheldAfterAsOf > 0 && <p className={styles.note}>{d.requests.withheldAfterAsOf} completed after the time asked for and are not shown.</p>}
        <div className={styles.tableWrap}>
          <table className={styles.requests}>
            <thead>
              <tr>
                <th scope="col">Scope</th>
                <th scope="col">Endpoint</th>
                <th scope="col">HTTP</th>
                <th scope="col">Attempts</th>
                <th scope="col">Started</th>
                <th scope="col">Received</th>
              </tr>
            </thead>
            <tbody>
              {d.requests.items.map((r, i) => (
                <tr key={i}>
                  <td>{r.scope}</td>
                  <td className="mono">
                    {r.source === "gamma" ? "Gamma" : "CLOB"} {r.endpoint}
                  </td>
                  <td>{r.httpStatus ?? (r.errorKind === null ? "None" : r.errorKind)}</td>
                  <td>{r.attempts}</td>
                  <td className="mono">{time(r.startedAt)}</td>
                  <td className="mono">{time(r.receivedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function StoredBook({ book: b }: { book: Book }) {
  const scale = barScale([...b.levels.bids, ...b.levels.asks]);
  const label = b.labelObserved;
  const order = ORDER_TEXT[b.levels.order];
  return (
    <article className={`${styles.book} ${b.quality === "invalid" ? styles.invalid : ""}`} aria-label={`Book of outcome ${b.outcomeIndex + 1}: ${label}`}>
      <header className={styles.bookHeader}>
        <span className={styles.bookLabel}>{label}</span>
        <span className={styles.meta}>Outcome {b.outcomeIndex + 1}</span>
        <span className={`${styles.chip} ${b.quality === "valid" ? styles.ok : styles.warnChip}`}>Quality: {QUALITY_TEXT[b.quality]}</span>
      </header>
      {b.issues.length > 0 && (
        <ul className={styles.issues} aria-label={`Quality issues for ${label}`}>
          {b.issues.map((issue, i) => (
            <li key={`${issue.code}-${i}`}>
              <code>{issue.code}</code> ({issue.severity}) {issueText(issue.code)}
            </li>
          ))}
        </ul>
      )}
      <dl className={styles.facts}>
        <Fact term={b.assetIdKind === "positionId" ? "Position ID" : "Token ID"} mono>
          {b.assetId}
        </Fact>
        <Fact term="Book reported asset" mono>
          {b.reportedAssetId}
        </Fact>
        <Fact term="Book reported condition" mono>
          {b.reportedConditionId}
        </Fact>
        <Fact term="Polymarket book timestamp" mono>
          {b.serverTimestamp.iso === null ? `${orUnknown(b.serverTimestamp.raw)} (raw)` : `${time(b.serverTimestamp.iso)} (raw ${b.serverTimestamp.raw ?? ""})`}
        </Fact>
        <Fact term="Request" mono>
          HTTP {b.request.httpStatus} · {b.request.attempts} {b.request.attempts === 1 ? "attempt" : "attempts"} · {formatMs(b.request.durationMs)}
        </Fact>
        <Fact term="First attempt started" mono>
          {time(b.request.firstAttemptStartedAt)}
        </Fact>
        <Fact term="Response received" mono>
          {time(b.request.responseReceivedAt)}
        </Fact>
        <Fact term="Server Date header" mono>
          {b.request.serverDateHeader ?? NOT_REPORTED}
        </Fact>
        <Fact term="Tick size" mono>
          {orUnknown(b.tickSize)}
        </Fact>
        <Fact term={`Minimum order size (${SIZE_UNIT})`} mono>
          {formatShares(b.minOrderSize)}
        </Fact>
        <Fact term="Last trade price" mono>
          {orUnknown(b.lastTradePrice)}
        </Fact>
        <Fact term="Content hash" mono>
          {b.contentHash}
        </Fact>
        <Fact term="Polymarket hash" mono>
          {b.upstreamHash ?? NOT_REPORTED}
        </Fact>
      </dl>
      <p className={styles.note}>
        {b.levels.bids.length} of {b.levels.totalBids} bid and {b.levels.asks.length} of {b.levels.totalAsks} ask levels, {order}.
      </p>
      <div className={styles.sides}>
        <LadderSide side="bid" levels={b.levels.bids} scale={scale} label={label} orderNote={order} />
        <LadderSide side="ask" levels={b.levels.asks} scale={scale} label={label} orderNote={order} />
      </div>
    </article>
  );
}

const dec = (v: string | null) => v ?? NOT_REPORTED;

function MetricsCard({ metrics: m, labels, inUse }: { metrics: MetricsRow; labels: readonly string[]; inUse: boolean }) {
  return (
    <article className={`${styles.metrics} ${inUse ? styles.inUse : ""}`} aria-label={`Metrics, analytics version ${m.analyticsVersion}`}>
      <header className={styles.bookHeader}>
        <span className={styles.bookLabel}>Analytics v{m.analyticsVersion}</span>
        <span className={`${styles.chip} ${m.computedBy === "collect" ? styles.ok : ""}`}>{m.computedBy === "collect" ? "At collection" : "Recomputed later"}</span>
        {m.retrospective && <span className={`${styles.chip} ${styles.warnChip}`}>Retrospective: computed after the time asked for</span>}
        {inUse && <span className={styles.meta}>Used by this history</span>}
      </header>
      <dl className={styles.facts}>
        <Fact term="Computed at" mono>
          {time(m.computedAt)}
        </Fact>
        <Fact term="Reference outcome">
          {labels[m.referenceIndex] ?? `outcome ${m.referenceIndex + 1}`} (outcome {m.referenceIndex + 1})
        </Fact>
        <Fact term="Book state">{m.state === null ? NOT_REPORTED : STATE_TEXT[m.state]}</Fact>
        <Fact term="Quality">{QUALITY_TEXT[m.quality]}</Fact>
        <Fact term="Best bid (size)" mono>
          {dec(m.bestBid)} ({m.bestBidSize === null ? NOT_REPORTED : formatShares(m.bestBidSize)})
        </Fact>
        <Fact term="Best ask (size)" mono>
          {dec(m.bestAsk)} ({m.bestAskSize === null ? NOT_REPORTED : formatShares(m.bestAskSize)})
        </Fact>
        <Fact term="Spread · midpoint" mono>
          {dec(m.spread)} · {dec(m.midpoint)}
        </Fact>
        <Fact term="Top size · notional" mono>
          {m.topSize === null ? NOT_REPORTED : formatShares(m.topSize)} · {dec(m.topNotional)}
        </Fact>
        <Fact term={`Bid · ask depth (${SIZE_UNIT})`} mono>
          {m.bidDepth === null ? NOT_REPORTED : formatShares(m.bidDepth)} · {m.askDepth === null ? NOT_REPORTED : formatShares(m.askDepth)}
        </Fact>
        <Fact term={`Within ${m.depthBand ?? "no band"} of best`} mono>
          {m.bidBandDepth === null ? NOT_REPORTED : formatShares(m.bidBandDepth)} · {m.askBandDepth === null ? NOT_REPORTED : formatShares(m.askBandDepth)}
        </Fact>
        <Fact term="Levels (bid · ask)" mono>
          {m.bidLevels ?? NOT_REPORTED} · {m.askLevels ?? NOT_REPORTED}
        </Fact>
        <Fact term="Pair skew" mono>
          {formatMs(m.pairSkewMs)}
        </Fact>
        <Fact term="Computed by app">{m.appVersion}</Fact>
      </dl>
    </article>
  );
}
