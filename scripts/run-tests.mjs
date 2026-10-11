import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const directory = new URL("../tests/", import.meta.url);
const files = readdirSync(directory).filter((name) => name.endsWith(".test.ts"))
  .sort().map((name) => fileURLToPath(new URL(name, directory)));
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...files], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
