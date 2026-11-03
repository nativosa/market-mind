import type { ApiClient, Version } from "./api";
import { MCP_LIMITS } from "../../src/research/contracts";
import { canLoadMore, marketById, needsFirstPage, type Action, type ExplorerState } from "./explorer";

/** Inspections always ask for the most levels the API returns; the ladder depth is chosen locally. */
export const INSPECT_LEVELS = MCP_LIMITS.inspect.levels.max;

/**
 * The explorer's request logic, free of React so it can be tested directly. Every request is an
 * explicit call (initial page, version switch, "load more", retry or refresh); nothing polls or
 * retries on its own. One AbortController per version: a new request for a version aborts the one
 * it supersedes, and the reducer drops any answer that still arrives for an old request id.
 *
 * Inspections follow the same rules with a single AbortController: only the selected market is ever
 * inspected. They start from the selection handler itself (never from a React effect), so a
 * development double-render or double-mounted effect cannot send a second inspection. React applies
 * a dispatch only at its next render, so the selection and the inspection in flight are also tracked
 * here: a second click that arrives before that render is still recognised as a repeat.
 */
export interface ExplorerController {
  /** Load the first page (replacing loaded pages) or the next page of `version`. */
  load(version: Version, mode: "first" | "more"): void;
  /** Show another version, aborting the shown version's request; loads its first page if needed. */
  switchVersion(version: Version): void;
  /** Load the shown version's first page if it has none and none is pending or failed. */
  ensureFirstPage(): void;
  /**
   * Select a market (or none). Any other market's inspection is aborted and released. With
   * `inspect`, an inspectable market is inspected at once; re-selecting the shown market does nothing.
   */
  select(id: string | null, options?: { inspect?: boolean }): void;
  /** Inspect the selected market now (first time, retry or refresh); ignored while one is loading. */
  inspect(): void;
  /** Abort the selected market's inspection in flight. */
  cancelInspection(): void;
  /** Fetch server status once (version, budget). */
  loadStatus(): void;
  /** Abort everything in flight (unmount). */
  dispose(): void;
}

export function createController(api: ApiClient, dispatch: (action: Action) => void, getState: () => ExplorerState): ExplorerController {
  const controllers: Record<Version, AbortController | null> = { v1: null, v2: null };
  let statusController: AbortController | null = null;
  let inspectController: AbortController | null = null;
  /** The market of the inspection in flight. */
  let inspecting: string | null = null;
  /** The latest selection made through this controller (undefined: none yet, use the state's). */
  let selection: string | null | undefined;
  const selectedId = () => (selection === undefined ? getState().selectedId : selection);
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

  const loadStatus = () => {
    statusController?.abort();
    const controller = new AbortController();
    statusController = controller;
    void api.status(controller.signal).then((result) => dispatch(result.ok ? { type: "status", status: result.data } : { type: "status_failed", error: result.error }));
  };

  const inspect = () => {
    const id = selectedId();
    if (id === null || (inspectController !== null && inspecting === id)) return;
    inspectController?.abort();
    const controller = new AbortController();
    inspectController = controller;
    inspecting = id;
    const requestId = ++nextRequest;
    dispatch({ type: "inspect_request", id, requestId });
    void api.inspect(id, { levels: INSPECT_LEVELS }, controller.signal).then((result) => {
      if (inspectController === controller) {
        inspectController = null;
        inspecting = null;
      }
      dispatch(result.ok ? { type: "inspected", requestId, data: result.data, receivedAt: result.receivedAt } : { type: "inspect_failed", requestId, error: result.error });
      // The inspection contract carries no rolling-window figures: ask the local server (no upstream request).
      if (result.ok || result.error.kind === "server") loadStatus();
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
    select(id, { inspect: start = true } = {}) {
      if (id === selectedId()) return;
      inspectController?.abort(); // superseded: its answer would be stale
      inspectController = null;
      inspecting = null;
      selection = id;
      dispatch({ type: "select", id });
      // A market the listing already marked as not inspectable is not requested automatically.
      if (id !== null && start && marketById(getState(), id)?.eligibility.inspectable !== false) inspect();
    },
    inspect,
    cancelInspection() {
      inspectController?.abort();
    },
    loadStatus,
    dispose() {
      statusController?.abort();
      inspectController?.abort();
      for (const version of ["v1", "v2"] as const) controllers[version]?.abort();
    },
  };
}
