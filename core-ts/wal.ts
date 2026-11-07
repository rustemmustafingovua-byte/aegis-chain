/**
 * AEGIS WAL v1.3 — Write-Ahead Log для durable chain persistence.
 *
 * Проблема v1.2: saveToFile после каждого блока (sync full JSON rewrite) — дорого при росте цепи.
 * WAL: append-only NDJSON blocks (один block per line). На старте snapshot грузится как раньше,
 * WAL служит durable append-логом блоков (audit + fast tail), compact раз в SNAPSHOT_EVERY.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Block } from "./chain.js";
import { stringify } from "./ledger.js";

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

export function walPaths(stateFile: string) {
  const dir = path.dirname(stateFile);
  const base = path.basename(stateFile).replace(/\.json$/, "");
  return { walPath: path.join(dir, `${base}.wal.ndjson`), snapshotPath: stateFile };
}
