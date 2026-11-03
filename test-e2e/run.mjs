// Runs Playwright from the repository's real on-disk path. On Windows a working directory whose
// letter case differs from the disk (C:\git vs C:\GIT) makes Playwright load @playwright/test twice
// and find no tests; the native real path has the exact case.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";

const cwd = realpathSync.native(process.cwd());
const cli = createRequire(`${cwd}/package.json`).resolve("@playwright/test/cli");
const result = spawnSync(process.execPath, [cli, "test", ...process.argv.slice(2)], { cwd, stdio: "inherit" });
process.exit(result.status ?? 1);
