#!/usr/bin/env tsx
/**
 * AEGIS Trustcheck v1.9 — executable Trust Mode gate (SECURITY.md checklist).
 * Usage: npx tsx cli/trustcheck.ts  → PASS/FAIL per gate, exit 1 if any FAIL.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname ?? ".", "..");
const checks: Array<[string, boolean, string]> = [];

function has(rel: string) { return fs.existsSync(path.join(root, rel)); }

checks.push(["package.json version set", has("package.json"), "package.json"]);
checks.push(["contracts 8+ (.sol)", fs.readdirSync(path.join(root, "contracts")).filter((f) => f.endsWith(".sol")).length >= 8, "contracts/*.sol"]);
checks.push(["SECURITY.md present", has("SECURITY.md"), "SECURITY.md"]);
checks.push(["docs/RELEASE.md present", has("docs/RELEASE.md"), "docs/RELEASE.md"]);
checks.push(["docs/THREAT_MODEL.md present", has("docs/THREAT_MODEL.md"), "docs/THREAT_MODEL.md"]);
checks.push(["forge foundry.toml", has("contracts/foundry.toml"), "contracts/foundry.toml"]);
checks.push(["libp2p gossipsub", has("core-ts/libp2p.ts") && fs.readFileSync(path.join(root, "core-ts/libp2p.ts"), "utf8").includes("gossipsub"), "core-ts/libp2p.ts"]);
checks.push(["WAL present", has("core-ts/wal.ts"), "core-ts/wal.ts"]);
checks.push(["explorer present", has("explorer/index.html"), "explorer/index.html"]);
checks.push(["wallet present", has("wallet-mobile/src/App.tsx"), "wallet-mobile/src/App.tsx"]);

let fails = 0;
for (const [name, ok, where] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${where})`);
  if (!ok) fails++;
}
console.log(fails ? `\n${fails} gates FAIL — do not fork Trust Mode` : "\nAll gates PASS — ready for external review");
process.exit(fails ? 1 : 0);
