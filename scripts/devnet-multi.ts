/**
 * AEGIS multi-node devnet (v1.16).
 *
 *   npx tsx scripts/devnet-multi.ts            # запустить 3 узла и жить (Ctrl+C)
 *   npx tsx scripts/devnet-multi.ts --check     # поднять, проверить конвергенцию, выйти
 *
 * Что проверяется:
 *   - у каждого узла свой валидаторский ключ (AEGIS_VALIDATOR_SEED)
 *   - общий генезис (AEGIS_GENESIS_VALIDATORS) → одинаковый stateRoot
 *   - узлы 2 и 3 подключаются к узлу 1 (AEGIS_BOOTSTRAP) и догоняют его
 *   - блоки производит только избранный на слот валидатор
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { hybridGenerate } from "../core-ts/hybrid.js";
import { sha256 } from "../core-ts/crypto.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = path.join(os.homedir(), ".local/state/aegis-devnet");
const PORTS = [8901, 8902, 8903];
const SEEDS = ["aegis-devnet-validator-alpha-01", "aegis-devnet-validator-bravo-02", "aegis-devnet-validator-charlie-03"];
const CHECK = process.argv.includes("--check");
/** how many blocks must exist before --check declares success */
const CHECK_HEIGHT = Number(process.env.CHECK_HEIGHT ?? 3);

type NodeHandle = { port: number; proc: ChildProcess; log: string };

async function rpc(port: number, method: string, params: any[] = []): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j: any = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

function seedBuf(label: string): Buffer {
  return Buffer.from(sha256(label), "hex");
}

function writeGenesis(): string {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const validators = SEEDS.map((s, i) => {
    const kp = hybridGenerate(seedBuf(s));
    return {
      edPublic: kp.edPublic,
      mlPublicKeyB64: Buffer.from(kp.mlPublicKey).toString("base64"),
      stake: "10000000000",
      address: kp.address,
      balance: "100000000000",
      humanityScore: 90,
      label: `node-${i + 1}`,
    };
  });
  const file = path.join(STATE_DIR, "genesis.json");
  fs.writeFileSync(file, JSON.stringify({ validators }, null, 2));
  return file;
}

function start(port: number, index: number, genesisFile: string): NodeHandle {
  const log = path.join(STATE_DIR, `node-${index + 1}.log`);
  const env = {
    ...process.env,
    AEGIS_VALIDATOR_SEED: SEEDS[index],
    AEGIS_STATE_FILE: path.join(STATE_DIR, `node-${index + 1}.json`),
    AEGIS_GENESIS_VALIDATORS: genesisFile,
    AEGIS_P2P_PORT: String(3900 + index + 1),
    AEGIS_LIBP2P_PORT: String(4900 + index + 1),
    AEGIS_EMPTY_BLOCK_SLOTS: process.env.AEGIS_EMPTY_BLOCK_SLOTS ?? "2",
    AEGIS_CHECKPOINT_EVERY: process.env.AEGIS_CHECKPOINT_EVERY ?? "2",
    AEGIS_BOOTSTRAP: index === 0 ? "" : "127.0.0.1:3901",
    // every node co-signs the others' checkpoints → light clients see ≥2/3 stake
    AEGIS_CHECKPOINT_PEERS: PORTS.filter((_, i) => i !== index).map((p) => `http://127.0.0.1:${p}`).join(","),
  };
  const out = fs.openSync(log, "a");
  // detached: own process group, so Ctrl+C / stopAll kills the real `tsx` child too
  // (killing the `npx` wrapper left orphan nodes holding the port on earlier runs)
  const proc = spawn("npx", ["tsx", "cli/aegis.ts", "serve", `--port=${port}`], { cwd: ROOT, env, stdio: ["ignore", out, out], detached: true });
  return { port, proc, log };
}

async function waitUp(port: number, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function snapshot(port: number) {
  try {
    const st = await rpc(port, "aeg_getState");
    return { port, height: st.height, head: st.head, stateRoot: st.stateRoot };
  } catch (e: any) {
    return { port, error: e.message };
  }
}

async function main() {
  const genesisFile = writeGenesis();
  console.log(`genesis: ${genesisFile} (${SEEDS.length} validators)`);
  const nodes = PORTS.map((p, i) => start(p, i, genesisFile));
  const stopAll = () => {
    for (const n of nodes) {
      try { process.kill(-n.proc.pid!, "SIGTERM"); } catch { try { n.proc.kill("SIGTERM"); } catch {} }
      // npx → tsx → node chain: make sure the actual server (holding the port) dies
      try { execSync(`pkill -f "aegis.ts serve --port=${n.port}"`, { stdio: "ignore" }); } catch { /* already gone */ }
    }
  };

  const ups = await Promise.all(nodes.map((n) => waitUp(n.port)));
  if (ups.includes(false)) {
    stopAll();
    throw new Error(`node did not start: ${JSON.stringify(ups.map((ok, i) => ({ port: PORTS[i], ok })))}`);
  }
  console.log(`nodes up: ${PORTS.join(", ")}`);

  const deadline = Date.now() + (CHECK ? 150_000 : 0);
  let converged = false;
  let last = "";
  while (true) {
    const states = await Promise.all(PORTS.map(snapshot));
    const heights = states.map((s: any) => s.height ?? -1);
    const heads = states.map((s: any) => s.head ?? null);
    const roots = states.map((s: any) => s.stateRoot ?? null);
    const allSame = new Set(heights).size === 1 && new Set(heads).size === 1 && new Set(roots).size === 1;
    const line = states.map((s: any) => `${s.port}:h${s.height ?? "?"}`).join(" ");
    if (line !== last) { console.log(line); last = line; }
    if (allSame && heights[0] >= CHECK_HEIGHT) { converged = true; if (CHECK) break; }
    if (CHECK && Date.now() > deadline) break;
    if (!CHECK && allSame) {
      const sync = await snapshot(PORTS[0]).catch(() => null);
      void sync;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  const states = await Promise.all(PORTS.map(snapshot));
  console.log("\nfinal state:");
  for (const s of states as any[]) console.log(`  :${s.port} height=${s.height} head=${String(s.head).slice(0, 16)}… root=${String(s.stateRoot).slice(0, 16)}…`);
  const proposers: Record<string, number> = {};
  for (let h = 1; h <= (states[0] as any).height; h++) {
    try {
      const b = await rpc(PORTS[0], "aeg_getBlock", [h]);
      const who = String(b?.header?.proposer ?? b?.proposer ?? "?").slice(0, 10);
      proposers[who] = (proposers[who] ?? 0) + 1;
    } catch { /* pruned */ }
  }
  console.log("\nblock proposers:", JSON.stringify(proposers));
  const cp = await rpc(PORTS[0], "aeg_checkpointLatest").catch(() => null);
  if (cp?.checkpoint) {
    const v = cp.verification ?? {};
    console.log(`checkpoint h=${cp.checkpoint.height}: signatures=${cp.checkpoint.signatures.length}, signed ${v.signedBps ?? "?"} bps, ok=${v.ok}`);
  }
  const sync = await rpc(PORTS[0], "aeg_syncStatus");
  console.log("\nsync status (node 1):");
  console.log(`  peers: ${sync.tcp?.peers?.length ?? 0}, forksSeen=${sync.tcp?.forksSeen ?? 0}`);
  for (const p of sync.tcp?.sync ?? []) console.log(`  peer ${p.peerId}: height=${p.height ?? "?"} attempts=${p.attempts} failures=${p.failures} lastSyncAt=${p.lastSyncAt ? new Date(p.lastSyncAt).toISOString() : "-"}`);

  if (CHECK) {
    try {
      if (!converged) { console.error("FAIL: nodes did not converge"); process.exit(1); }
      const latest = await rpc(PORTS[0], "aeg_checkpointLatest").catch(() => null);
      const bps = latest?.verification?.signedBps ?? 0;
      if (bps < 6667) { console.error(`FAIL: checkpoint quorum ${bps} bps < 6667 (signatures ${latest?.checkpoint?.signatures?.length ?? 0})`); process.exit(1); }
      console.log(`checkpoint quorum: ${bps} bps across ${latest.checkpoint.signatures.length} signatures`);
      console.log("\nOK: 3 nodes converged on the same head/stateRoot");
      process.exit(0);
    } finally {
      stopAll();
    }
  }
  process.on("SIGINT", () => { stopAll(); process.exit(0); });
  process.on("SIGTERM", () => { stopAll(); process.exit(0); });
  console.log("\nrunning — Ctrl+C to stop (Ctrl+C kills all three nodes)");
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
