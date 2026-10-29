import { hostname } from "node:os";

export type ProcessState = "alive" | "gone" | "unknown";

export interface Liveness {
  hostname(): string;
  probe(pid: number): ProcessState;
}

/**
 * Signal 0 checks existence without delivering anything. ESRCH proves the process is gone; EPERM
 * means it exists but belongs to someone else (alive). pid <= 0 addresses process groups, so it
 * is never a valid owner. Anything unexpected is "unknown", which recovery treats as not provable.
 */
export const realLiveness: Liveness = {
  hostname: () => hostname(),
  probe(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
    try {
      process.kill(pid, 0);
      return "alive";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return "gone";
      if (code === "EPERM") return "alive";
      return "unknown";
    }
  },
};
