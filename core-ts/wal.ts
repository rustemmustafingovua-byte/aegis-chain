/**
 * AEGIS WAL v1.3 — Write-Ahead Log для durable chain persistence.
 *
 * Проблема v1.2: saveToFile после каждого блока (sync full JSON rewrite) — дорого при росте цепи.
 * WAL: append-only NDJSON blocks (один block per line). На старте snapshot грузится как раньше,
 * WAL служит durable append-логом блоков (audit + fast tail), compact раз в SNAPSHOT_EVERY.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Block, Chain } from "./chain.js";
import { stringify, parseTx } from "./ledger.js";

export const WAL_SNAPSHOT_EVERY = 1000;

export class Wal {
  walPath: string;
  snapshotPath: string;
  blocks = 0;
  bytes = 0;

  constructor(walPath: string, snapshotPath: string) {
    this.walPath = walPath;
    this.snapshotPath = snapshotPath;
    try {
      if (fs.existsSync(walPath)) {
        const st = fs.statSync(walPath);
        this.bytes = st.size;
        const head = fs.readFileSync(walPath, "utf8").trim();
        this.blocks = head ? head.split("\n").length : 0;
      }
    } catch {}
  }

  /** Append one block (NDJSON, sync append; fsync every 100). */
  append(block: Block) {
    const line = stringify(block) + "\n";
    fs.appendFileSync(this.walPath, line, "utf8");
    this.blocks += 1;
    this.bytes += Buffer.byteLength(line);
    if (this.blocks % 100 === 0) {
      try { const fd = fs.openSync(this.walPath, "r"); fs.fsyncSync(fd); fs.closeSync(fd); } catch {}
    }
  }

  /** Compact: caller saves chain snapshot, then WAL clears. */
  compact(chain: { saveToFile(p: string): void }) {
    chain.saveToFile(this.snapshotPath);
    fs.writeFileSync(this.walPath, "", "utf8");
    this.blocks = 0;
    this.bytes = 0;
  }

  status(height: number) {
    return { walPath: this.walPath, snapshotPath: this.snapshotPath, walBlocks: this.blocks, walBytes: this.bytes, height };
  }
}

/**
 * v1.13: durability. On startup a node loads the snapshot and replays WAL blocks
 * newer than it. Handles torn last line (crash mid-append) by stopping at the
 * first unparseable/invalid block instead of throwing away the whole log.
 */
export function replayWal(chain: Chain, walPath: string): { applied: number; skipped: number; corrupt: boolean; height: number } {
  let applied = 0, skipped = 0, corrupt = false;
  if (!fs.existsSync(walPath)) return { applied, skipped, corrupt, height: chain.height };
  let text = "";
  try { text = fs.readFileSync(walPath, "utf8"); } catch { return { applied, skipped, corrupt: true, height: chain.height }; }
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: any;
    try { raw = JSON.parse(trimmed); } catch { corrupt = true; break; } // torn tail
    try {
      const b: Block = { ...raw, txs: (raw.txs ?? []).map((t: any) => parseTx(t)) };
      const height = b.header?.height;
      if (typeof height !== "number") { corrupt = true; break; }
      if (height <= chain.height) { skipped++; continue; }
      if (height !== chain.height + 1) { corrupt = true; break; } // gap: cannot apply
      chain.accept(b);
      applied++;
    } catch {
      corrupt = true;
      break;
    }
  }
  return { applied, skipped, corrupt, height: chain.height };
}

export function walPaths(stateFile: string) {
  const dir = path.dirname(stateFile);
  const base = path.basename(stateFile).replace(/\.json$/, "");
  return { walPath: path.join(dir, `${base}.wal.ndjson`), snapshotPath: stateFile };
}
