/**
 * Something that may grant permission for one HTTP attempt. Every grant is final: a granted
 * attempt counts as used whether or not the request later succeeds.
 */
export interface RequestPermit {
  tryAcquire(): boolean;
}

/** Units set aside for one unit of work. Attempts draw from it first, then from the free pool. */
export interface Reservation extends RequestPermit {
  readonly remaining: number;
  /** Return unused units to the pool. Idempotent. */
  release(): void;
}

export interface RequestBudget extends RequestPermit {
  readonly limit: number;
  readonly used: number;
  readonly reserved: number;
  /** Set aside `n` units, or return null if they are not all available. */
  reserve(n: number): Reservation | null;
}

/**
 * Hard cap on HTTP attempts. Every method is synchronous, so a check and its increment can never
 * interleave with another caller: the limit holds under any amount of concurrent work.
 * Invariant: used + reserved <= limit.
 */
export function createRequestBudget(limit: number): RequestBudget {
  let used = 0;
  let reserved = 0;
  const free = () => limit - used - reserved;

  const budget: RequestBudget = {
    limit,
    get used() {
      return used;
    },
    get reserved() {
      return reserved;
    },
    tryAcquire() {
      if (free() <= 0) return false;
      used++;
      return true;
    },
    reserve(n) {
      if (n < 1 || free() < n) return null;
      reserved += n;
      let remaining = n;
      return {
        get remaining() {
          return remaining;
        },
        tryAcquire() {
          if (remaining > 0) {
            remaining--;
            reserved--;
            used++;
            return true;
          }
          return budget.tryAcquire();
        },
        release() {
          reserved -= remaining;
          remaining = 0;
        },
      };
    },
  };
  return budget;
}
