import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolation guarantee: anything that falls back to MARKETMIND_DB lands in a per-worker temp file,
// never in the repository's data/ directory. Tests always pass explicit temp or :memory: paths.
process.env.MARKETMIND_DB = join(tmpdir(), `marketmind-test-${process.pid}.sqlite`);

// Offline guarantee: any accidental real network call fails loudly.
globalThis.fetch = () => {
  throw new Error("Network access is forbidden in offline tests; inject a fake fetch instead.");
};
