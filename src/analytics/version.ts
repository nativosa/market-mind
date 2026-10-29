/**
 * Version of every derived calculation that is persisted (book quality rules, book metrics, scan
 * metrics). Bump it whenever any definition changes: stored metrics are keyed by this version, so
 * results of different algorithms are never mixed.
 */
export const ANALYTICS_VERSION = 1;
