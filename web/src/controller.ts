import type { ApiClient, Version } from "./api";
import { canLoadMore, needsFirstPage, type Action, type ExplorerState } from "./explorer";

/**
 * The explorer's request logic, free of React so it can be tested directly. Every request is an
 * explicit call (initial page, version switch, "load more", retry or refresh); nothing polls or
 * retries on its own. One AbortController per version: a new request for a version aborts the one
 * it supersedes, and the reducer drops any answer that still arrives for an old request id.
 */
export interface ExplorerController {
  /** Load the first page (replacing loaded pages) or the next page of `version`. */
  load(version: Version, mode: "first" | "more"): void;
  /** Show another version, aborting the shown version's request; loads its first page if needed. */
  switchVersion(version: Version): void;
  /** Load the shown version's first page if it has none and none is pending or failed. */
  ensureFirstPage(): void;
  /** Fetch server status once (version, budget). */
  loadStatus(): void;
  /** Abort everything in flight (unmount). */
  dispose(): void;
}

export function createController(api: ApiClient, dispatch: (action: Action) => void, getState: () => ExplorerState): ExplorerController {
  const controllers: Record<Version, AbortController | null> = { v1: null, v2: null };
  let statusController: AbortController | null = null;
  let nextRequest = 0;

  const load = (version: Version, mode: "first" | "more") => {
    const feed = getState().feeds[version];
    // Also guards double clicks that arrive before the disabled button has re-rendered.
    if (mode === "more" && (controllers[version] !== null || !canLoadMore(feed))) return;
    controllers[version]?.abort();
    const controller = new AbortController();
    controllers[version] = controller;
    const requestId = ++nextRequest;
    dispatch({ type: "request", version, mode, requestId });
    void api.markets({ version, cursor: mode === "more" ? feed.nextCursor : null }, controller.signal).then((result) => {
      if (controllers[version] === controller) controllers[version] = null;
      dispatch(result.ok ? { type: "loaded", version, requestId, page: result.data, receivedAt: result.receivedAt } : { type: "failed", version, requestId, error: result.error });
    });
  };

  return {
    load,
    switchVersion(version) {
      const shown = getState().version;
      if (version === shown) return;
      controllers[shown]?.abort(); // superseded: its answer would be stale
      dispatch({ type: "version", version });
      if (needsFirstPage(getState().feeds[version])) load(version, "first");
    },
    ensureFirstPage() {
      const state = getState();
      if (needsFirstPage(state.feeds[state.version])) load(state.version, "first");
    },
    loadStatus() {
      statusController?.abort();
      const controller = new AbortController();
      statusController = controller;
      void api.status(controller.signal).then((result) => dispatch(result.ok ? { type: "status", status: result.data } : { type: "status_failed", error: result.error }));
    },
    dispose() {
      statusController?.abort();
      for (const version of ["v1", "v2"] as const) controllers[version]?.abort();
    },
  };
}
