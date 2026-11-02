import type { ReactNode } from "react";
import type { ApiError } from "../api";
import { describeApiError, formatDuration } from "../format";
import styles from "./Notice.module.css";

export function Notice({ tone = "info", title, children }: { tone?: "info" | "warning" | "error"; title: string; children?: ReactNode }) {
  const toneClass = tone === "error" ? styles.error : tone === "warning" ? styles.warning : "";
  return (
    <div className={`${styles.notice} ${toneClass}`} role={tone === "error" ? "alert" : "status"}>
      <p className={styles.title}>{title}</p>
      {children}
    </div>
  );
}

export function LoadingRows({ label }: { label: string }) {
  return (
    <div className={styles.skeleton} role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className={`${styles.bar} pulse`} aria-hidden="true" />
      ))}
    </div>
  );
}

/**
 * A failed request, with the server's retry guidance. Retrying is always an explicit click, and
 * the button stays disabled while the server has said a retry cannot succeed yet.
 */
export function ErrorNotice({ error, now, onRetry, retryLabel = "Try again", context }: { error: ApiError; now: number; onRetry?: () => void; retryLabel?: string; context?: string }) {
  const view = describeApiError(error, now);
  const waiting = view.retryInMs !== null && view.retryInMs > 0;
  const code = error.kind === "server" ? (error.error.code ?? error.error.category) : error.kind === "invalid_response" ? `HTTP ${error.httpStatus}` : null;
  return (
    <Notice tone={view.retryable ? "warning" : "error"} title={context ? `${context}: ${view.title}` : view.title}>
      <p className={styles.detail}>{view.detail}</p>
      <div className={styles.actions}>
        {waiting && <span>Retry possible in about {formatDuration(view.retryInMs!)}.</span>}
        {view.retryInMs === 0 && <span>You can retry now.</span>}
        {onRetry && view.retryable && (
          <button type="button" onClick={onRetry} disabled={waiting}>
            {retryLabel}
          </button>
        )}
        {code && <span className={styles.code}>Code: {code}</span>}
      </div>
    </Notice>
  );
}
