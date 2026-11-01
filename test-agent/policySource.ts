// Where each registered investigator policy is stored, for the controlled comparison only (experiment.ts). The
// normal runners keep reading the repository's own files and take no policy option.
//
// A policy can be named only by version, never by path. Its files come from an exact commit in the git object
// store, so the working tree cannot affect either arm, and every file must match the complete hashes registered
// in agent-sdk/policy.ts. Anything else throws, before any model request can be made.
import { spawnSync } from "node:child_process";
import { POLICY_REGISTRY, policyVersionOf, type PolicyHashes, type PolicyVersion } from "../agent-sdk/policy.js";
import { INVESTIGATOR_FILES, REPO, sha256 } from "./processes.js";

export type RegisteredPolicy = Exclude<PolicyVersion, "unregistered">;
export const CONTROL: RegisteredPolicy = "policy-v1";
export const TREATMENT: RegisteredPolicy = "policy-v2";

/** The commit holding each policy. A release tag, if any, must still resolve to that commit. */
export const POLICY_SOURCES: Record<RegisteredPolicy, { commit: string; tag: string | null }> = {
  "policy-v1": { commit: "9559f9a5081d7e29d2f73527718b3ba0c5e3ff6f", tag: "v0.7.0" },
  "policy-v2": { commit: "5f4065c0fb3693ae17a08d2d3b9cef7ec8673ab2", tag: null },
};

export interface LoadedPolicy {
  version: RegisteredPolicy;
  commit: string;
  tag: string | null;
  hashes: PolicyHashes;
  /** File contents by repository path, exactly as stored. */
  files: Record<string, Buffer>;
}

export interface GitReader {
  /** The commit a tag resolves to, or null. */
  tagCommit(tag: string): string | null;
  /** A file's bytes at a commit, or null. */
  show(commit: string, path: string): Buffer | null;
}

const git = (args: string[]) => spawnSync("git", args, { cwd: REPO, maxBuffer: 1 << 24 });
export const repositoryGit: GitReader = {
  tagCommit: (tag) => {
    const r = git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
    return r.status === 0 ? r.stdout.toString("utf8").trim() : null;
  },
  show: (commit, path) => {
    const r = git(["show", `${commit}:${path}`]);
    return r.status === 0 ? r.stdout : null;
  },
};

export class PolicyError extends Error {}

const isRegistered = (name: string): name is RegisteredPolicy => POLICY_REGISTRY.some((p) => p.version === name);

export function loadPolicy(name: string, reader: GitReader = repositoryGit): LoadedPolicy {
  if (!isRegistered(name)) throw new PolicyError(`${name} is not a registered policy`);
  const { commit, tag } = POLICY_SOURCES[name];
  if (tag !== null) {
    const found = reader.tagCommit(tag);
    if (found !== commit) throw new PolicyError(`${name}: tag ${tag} resolves to ${String(found)}, not the verified ${commit}`);
  }
  const files: Record<string, Buffer> = {};
  for (const path of Object.values(INVESTIGATOR_FILES)) {
    const bytes = reader.show(commit, path);
    if (bytes === null) throw new PolicyError(`${name}: ${path} is missing at ${commit}`);
    files[path] = bytes;
  }
  const hashes: PolicyHashes = {
    agentSha256: sha256(files[INVESTIGATOR_FILES.agent]!),
    skillSha256: sha256(files[INVESTIGATOR_FILES.skill]!),
    settingsSha256: sha256(files[INVESTIGATOR_FILES.settings]!),
  };
  if (policyVersionOf(hashes) !== name) throw new PolicyError(`${name}: the files at ${commit} do not match its registered hashes`);
  return { version: name, commit, tag, hashes, files };
}
