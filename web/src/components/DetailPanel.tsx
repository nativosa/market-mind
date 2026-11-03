import type { Inspection, MarketItem } from "../api";
import { ASSOCIATION_TEXT, CROSS_CHECK_TEXT, humanNote, roleText } from "../book";
import type { InspectionState } from "../explorer";
import { formatDate, formatFlag, formatVolume, NOT_REPORTED } from "../format";
import { BookComparison } from "./BookComparison";
import { ErrorNotice, LoadingRows, Notice } from "./Notice";
import { Provenance } from "./Provenance";
import styles from "./DetailPanel.module.css";

const VOLUME_NOTE = "Gamma's reported 24h traded volume orders the list. It is not liquidity or order-book depth.";
export const DETAIL_HEADING_ID = "market-detail-heading";

export interface DetailPanelProps {
  /** Listing metadata, when the market is among the loaded ones. */
  market: MarketItem | null;
  selectedId: string | null;
  inspection: InspectionState;
  depth: number;
  now: number;
  onInspect: () => void;
  onCancel: () => void;
  onDepth: (depth: number) => void;
  onClose: () => void;
}

function Fact({ term, value, fromList = false }: { term: string; value: string; fromList?: boolean }) {
  return (
    <>
      <dt>{term}</dt>
      <dd className={value === NOT_REPORTED ? styles.unknown : undefined}>
        {value}
        {fromList && <span className={styles.source}> (from the market list)</span>}
      </dd>
    </>
  );
}

/**
 * A field the inspection may not report: its value when reported; otherwise the listing's value,
 * marked as such, rather than erasing what the list already showed.
 */
function known<T>(fromLive: T | null | undefined, fromList: T | null | undefined, format: (value: T | null) => string): { value: string; fromList: boolean } {
  if (fromLive !== undefined && fromLive !== null) return { value: format(fromLive), fromList: false };
  if (fromLive === null && fromList !== undefined && fromList !== null) return { value: format(fromList), fromList: true };
  return { value: format(fromLive ?? fromList ?? null), fromList: false };
}

/**
 * The selected market: listing metadata at once, then its live inspection. Market text is
 * third-party data and is rendered as React text only.
 */
export function DetailPanel(props: DetailPanelProps) {
  const { market, selectedId, inspection, onClose } = props;
  if (selectedId === null) {
    return (
      <aside className={styles.panel} aria-label="Market details">
        <p className={styles.heading}>Market details</p>
        <p className={styles.note}>Select a market to see its details and inspect its two order books.</p>
      </aside>
    );
  }
  const live = inspection.result?.data.market ?? null;
  const question = live?.question ?? market?.question ?? `Market ${selectedId}`;
  return (
    <aside className={styles.panel} aria-label="Market details">
      <div className={styles.top}>
        <button type="button" className={styles.back} onClick={onClose}>
          <span aria-hidden="true">&larr; </span>Back to markets
        </button>
        <p className={styles.heading}>Selected market</p>
      </div>
      <h2 id={DETAIL_HEADING_ID} className={styles.question} tabIndex={-1}>
        {question}
      </h2>
      <MarketFacts market={market} inspection={inspection.result?.data ?? null} selectedId={selectedId} />
      {market === null && live === null && <p className={styles.note}>This market is not among the loaded markets, so only an inspection can show its details.</p>}
      <InspectionSection {...props} />
      <Disclaimer inspection={inspection.result?.data ?? null} />
    </aside>
  );
}

function MarketFacts({ market, inspection, selectedId }: { market: MarketItem | null; inspection: Inspection | null; selectedId: string }) {
  const live = inspection?.market ?? null;
  const pick = (fromLive: string | undefined, fromList: string | undefined): string => fromLive ?? fromList ?? NOT_REPORTED;
  const protocol = live?.protocolVersion ?? market?.protocolVersion ?? null;
  const outcomes = inspection
    ? inspection.outcomes.map((o) => `${o.label} (${roleText(o.role)})`).join(" / ")
    : market
      ? `${market.outcomeLabels.join(" / ")}${market.outcomeCount > market.outcomeLabels.length ? ` (+${market.outcomeCount - market.outcomeLabels.length} more)` : ""}`
      : NOT_REPORTED;
  const warnings = [...new Set([...(market?.eligibility.warnings ?? []), ...(inspection?.eligibilityWarnings ?? [])])];
  return (
    <>
      <dl className={styles.facts}>
        <Fact term="Gamma ID" value={selectedId} />
        <Fact term="Condition ID" value={pick(live?.conditionId, market?.conditionId)} />
        <Fact term="Slug" value={pick(live?.slug, market?.slug)} />
        <Fact term="Protocol" value={protocol === null ? NOT_REPORTED : protocol.toUpperCase()} />
        <Fact term="Outcomes" value={outcomes} />
        <Fact term="Active" value={formatFlag(live ? live.active : (market?.active ?? null))} />
        <Fact term="Closed" value={formatFlag(live ? live.closed : (market?.closed ?? null))} />
        <Fact term="Accepting orders" {...known(live?.acceptingOrders, market?.acceptingOrders, formatFlag)} />
        <Fact term="Order book enabled" {...known(live?.enableOrderBook, market?.enableOrderBook, formatFlag)} />
        <Fact term="Neg-risk" {...known(live?.negRisk, market?.negRisk, formatFlag)} />
        <Fact term="Ends" {...known(live?.endDate, market?.endDate, formatDate)} />
        <Fact term="Gamma 24h volume" {...known(live?.gammaVolume24hr, market?.gammaVolume24hr, formatVolume)} />
        {market && <Fact term="Inspectable (listing)" value={formatFlag(market.eligibility.inspectable)} />}
        {inspection && <Fact term="Outcome pairing" value={`${ASSOCIATION_TEXT[inspection.association.method] ?? inspection.association.method}; ${CROSS_CHECK_TEXT[inspection.association.gammaIndexCrossCheck] ?? inspection.association.gammaIndexCrossCheck}`} />}
      </dl>
      <p className={styles.note}>
        {inspection ? "Metadata from the latest inspection. " : "Metadata from the market list. "}
        {VOLUME_NOTE}
      </p>
      {market && market.eligibility.reasons.length > 0 && <TextList title="Why it cannot be inspected" items={market.eligibility.reasons} />}
      {warnings.length > 0 && <TextList title="Eligibility warnings" items={warnings} />}
    </>
  );
}

function TextList({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div>
      <p className={styles.heading}>{title}</p>
      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

const COST_NOTE = "An inspection makes 4 requests to Polymarket (the market, its CLOB record and one order book per outcome), at most 8 attempts with retries.";

export function InspectionSection({ market, inspection, depth, now, onInspect, onCancel, onDepth }: DetailPanelProps) {
  const { result, error, loading } = inspection;
  if (loading && result === null) {
    return (
      <section className={styles.inspection} aria-label="Order-book inspection" aria-busy="true">
        <LoadingRows label="Inspecting the order books" />
        <div className={styles.actions}>
          <span className={styles.note}>Inspecting the order books. {COST_NOTE}</span>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </section>
    );
  }
  if (result === null) {
    return (
      <section className={styles.inspection} aria-label="Order-book inspection">
        {error === null ? <NotInspected market={market} onInspect={onInspect} /> : <InspectionError error={error} now={now} onInspect={onInspect} />}
      </section>
    );
  }
  const data = result.data;
  return (
    <section className={styles.inspection} aria-label="Order-book inspection" aria-busy={loading}>
      <div className={styles.actions}>
        <button type="button" onClick={onInspect} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh inspection"}
        </button>
        {loading && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <span className={styles.note}>Refreshing sends new requests; nothing refreshes on its own.</span>
      </div>
      {error && error.kind !== "aborted" && <ErrorNotice error={error} now={now} context="Refresh failed, the earlier result is shown" onRetry={onInspect} retryLabel="Refresh again" />}
      {error?.kind === "aborted" && (
        <Notice title="Refresh cancelled">
          <p className={styles.note}>The earlier result is still shown.</p>
        </Notice>
      )}
      {data.status === "invalid_book" && (
        <Notice tone="error" title="At least one order book is invalid">
          <p className={styles.note}>Metrics of an invalid book are withheld, and nothing comparing the two books should be read from this inspection.</p>
        </Notice>
      )}
      <BookComparison inspection={data} depth={depth} onDepth={onDepth} />
      <Provenance inspection={data} receivedAt={result.receivedAt} now={now} />
    </section>
  );
}

function NotInspected({ market, onInspect }: { market: MarketItem | null; onInspect: () => void }) {
  if (market?.eligibility.inspectable === false) {
    return (
      <Notice title="Order books were not requested">
        <p className={styles.note}>The market list marks this market as not inspectable (see the reasons above), so nothing was requested automatically.</p>
        <button type="button" onClick={onInspect}>
          Check with Polymarket anyway
        </button>
      </Notice>
    );
  }
  return (
    <Notice title="Not inspected yet">
      <p className={styles.note}>
        Nothing has been requested from Polymarket for this market yet. {COST_NOTE}
      </p>
      <button type="button" onClick={onInspect}>
        Inspect order books
      </button>
    </Notice>
  );
}

function InspectionError({ error, now, onInspect }: { error: NonNullable<InspectionState["error"]>; now: number; onInspect: () => void }) {
  if (error.kind === "aborted") {
    return (
      <Notice title="Inspection cancelled">
        <p className={styles.note}>The request was stopped and nothing is shown.</p>
        <button type="button" onClick={onInspect}>
          Inspect order books
        </button>
      </Notice>
    );
  }
  const issues = error.kind === "server" && Array.isArray(error.error.details.issues) ? error.error.details.issues.filter((i): i is string => typeof i === "string") : [];
  return (
    <>
      <ErrorNotice error={error} now={now} context="Inspection failed" onRetry={onInspect} />
      {issues.length > 0 && <TextList title="Reported reasons" items={issues} />}
    </>
  );
}

function Disclaimer({ inspection }: { inspection: Inspection | null }) {
  return (
    <section className={styles.disclaimer} aria-label="Research-only notice">
      <p>
        <strong>Research only.</strong> MarketMind cannot place orders and recommends none. A quoted spread is not a profit, displayed sizes are not guaranteed fills, and
        nothing here predicts what the market will do.
      </p>
      {inspection && (
        <>
          <p>{humanNote(inspection.evidenceNote)}</p>
          <ul className={styles.list}>
            {inspection.limitations.map((l) => (
              <li key={l}>{humanNote(l)}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
