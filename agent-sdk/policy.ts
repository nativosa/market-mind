// Reviewed investigator policies, identified only by the exact hashes of all three policy files. Any other
// combination is unregistered: a real SDK run refuses it, and evaluation records say so. Recorded runs keep
// the hashes they were written with; identity is added to new records and never written back to old ones.
import { z } from "zod";

export const PolicyVersion = z.enum(["policy-v1", "policy-v2", "unregistered"]);
export type PolicyVersion = z.infer<typeof PolicyVersion>;

export interface PolicyHashes {
  agentSha256: string;
  skillSha256: string;
  settingsSha256: string;
}

const SKILL = "3945a068adacad75c19ff9438e073e2b07ba6bb0c4f7ab86a8c315e230018e0d";
const SETTINGS = "cdaca77f2e89d29b5f0ffdbcb29e04ab29f5aed78df5e176664130821582c86b";

export const POLICY_REGISTRY: readonly ({ version: Exclude<PolicyVersion, "unregistered">; description: string } & PolicyHashes)[] = [
  { version: "policy-v1", description: "The investigator of v0.5.0 to v0.7.0", agentSha256: "2827bc57daa066771424fbe5f1f7bdc52843524a0f4187747a070b2e459e6c47", skillSha256: SKILL, settingsSha256: SETTINGS },
  { version: "policy-v2", description: "Stage 2.7: exact identifiers, evidence tagging, sampling disclosure, executability uncertainty", agentSha256: "c1a4778346fcafd6a05ed58f52a5ac990f73e502dbd29b77a8b292a647be5d34", skillSha256: SKILL, settingsSha256: SETTINGS },
];

export const policyVersionOf = (h: PolicyHashes): PolicyVersion =>
  POLICY_REGISTRY.find((p) => p.agentSha256 === h.agentSha256 && p.skillSha256 === h.skillSha256 && p.settingsSha256 === h.settingsSha256)?.version ?? "unregistered";
