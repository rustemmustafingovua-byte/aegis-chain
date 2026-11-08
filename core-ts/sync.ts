/**
 * AEGIS Sync v1.16 — догон цепочки между узлами без ложных банов.
 *
 * Проблема: узел, который отстал (перезапуск, сетевой разрыв, медленный канал),
 * получает `new_block` с высотой head+5. Старое поведение — штраф отправителю
 * и `bad height` → узел навсегда застревает, а честный пир теряет score.
 *
 * Здесь это разделено на две чистые части:
 *
 *   classifyBlock()  — что вообще пришло: next / duplicate / gap / fork
 *   SyncTracker      — кому и когда можно послать sync_request (cooldown, backoff)
 *
 * Транспорты (TCP lite, libp2p gossip) только принимают решения по этим данным,
 * поэтому логика покрыта тестами без сокетов.
 */
import type { Block, Chain } from "./chain.js";

export type BlockClass = "next" | "duplicate" | "gap" | "fork";

export type BlockRef = { height: number; prevHash: string; hash: string };

/** Плоский вид блока для классификатора (Block → BlockRef). */
export function blockRef(b: { header: { height: number; prevHash: string }; hash: string }): BlockRef {
  return { height: b.header.height, prevHash: b.header.prevHash, hash: b.hash };
}

/** Хеш блока на высоте (undefined, если блок уже прунен или ещё не получен). */
export function hashAtHeight(chain: Chain, height: number): string | undefined {
  if (height < 0) return undefined;
  const b = chain.blocks.find((x) => x.header.height === height);
  return b?.hash;
}

/**
 * Классификация входящего блока относительно текущей головы.
 *
 * - next      — продолжаем цепочку, можно принимать
 * - duplicate — уже есть (или старее головы), тихо игнорируем, НЕ штрафуем
 * - gap       — впереди, но не следующий: нужен sync_request, НЕ штрафуем
 * - fork      — конфликтует с нашей историей: наблюдаем, но не баним
 *               (честный форк из-за двух пропозеров — не атака)
 */
export function classifyBlock(chain: Chain, block: BlockRef): BlockClass {
  const head = chain.head;
  const headHeight = chain.height;
  if (!head) return block.height === 1 ? "next" : "gap";

  if (block.height === headHeight + 1) {
    return block.prevHash === head.hash ? "next" : "fork";
  }
  if (block.height > headHeight + 1) return "gap";
  // height <= head
  const known = hashAtHeight(chain, block.height);
  if (known === undefined) return "duplicate"; // прунено — не наша проблема
  return known === block.hash ? "duplicate" : "fork";
}

export type PeerSyncState = {
  peerId: string;
  /** высота пира, если известна (hello/pong/new_block) */
  height?: number;
  /** последняя высота, которую мы просили догнать */
  requestedFrom?: number;
  lastRequestAt?: number;
  attempts: number;
  failures: number;
  lastError?: string;
  lastSyncAt?: number;
  forwarded: number;
};

export type SyncTrackerOpts = {
  /** минимальный интервал между sync_request одному пиру */
  cooldownMs?: number;
  /** максимальный backoff после серии неудач */
  maxBackoffMs?: number;
  /** сколько неудач подряд терпим, прежде чем считать пир мёртвым */
  maxFailures?: number;
};

const DEFAULTS = { cooldownMs: 3_000, maxBackoffMs: 60_000, maxFailures: 6 };

/**
 * Учёт запросов синхронизации: не долбим пира каждым блоком, но и не спим
 * после первой же ошибки. Backoff экспоненциальный от числа неудач подряд.
 */
export class SyncTracker {
  readonly peers = new Map<string, PeerSyncState>();
  private readonly opts: Required<SyncTrackerOpts>;
  constructor(opts: SyncTrackerOpts = {}) { this.opts = { ...DEFAULTS, ...opts }; }

  peer(peerId: string): PeerSyncState {
    let st = this.peers.get(peerId);
    if (!st) { st = { peerId, attempts: 0, failures: 0, forwarded: 0 }; this.peers.set(peerId, st); }
    return st;
  }

  noteHeight(peerId: string, height: number) {
    const st = this.peer(peerId);
    if (st.height === undefined || height > st.height) st.height = height;
  }

  /** Можно ли сейчас просить этого пира догнать нас с высоты `fromHeight`. */
  shouldRequest(peerId: string, fromHeight: number, now = Date.now()): boolean {
    const st = this.peer(peerId);
    if (st.failures >= this.opts.maxFailures) return false;
    if (st.lastRequestAt === undefined) return true;
    if (st.requestedFrom !== undefined && fromHeight > st.requestedFrom) {
      // цель выросла — ждём только базовый cooldown, не backoff
      return now - st.lastRequestAt >= this.opts.cooldownMs;
    }
    const backoff = Math.min(this.opts.cooldownMs * 2 ** st.failures, this.opts.maxBackoffMs);
    return now - st.lastRequestAt >= backoff;
  }

  noteRequest(peerId: string, fromHeight: number, now = Date.now()) {
    const st = this.peer(peerId);
    st.requestedFrom = fromHeight;
    st.lastRequestAt = now;
    st.attempts++;
  }

  noteSuccess(peerId: string, now = Date.now()) {
    const st = this.peer(peerId);
    st.failures = 0;
    st.lastSyncAt = now;
    st.lastError = undefined;
  }

  noteFailure(peerId: string, reason: string, now = Date.now()) {
    const st = this.peer(peerId);
    st.failures++;
    st.lastError = reason;
    st.lastRequestAt = now;
  }

  noteForwarded(peerId: string) { this.peer(peerId).forwarded++; }

  remove(peerId: string) { this.peers.delete(peerId); }

  status() {
    return [...this.peers.values()].map((p) => ({ ...p }));
  }
}

export type ApplyResult =
  | { action: "applied"; cls: BlockClass }
  | { action: "ignored"; cls: BlockClass; reason: string }
  | { action: "sync"; cls: "gap"; fromHeight: number }
  | { action: "reject"; cls: BlockClass; reason: string };

/**
 * Единая политика для всех транспортов:
 *
 *   next      → chain.accept, relay
 *   duplicate → ignore (no penalty)
 *   gap       → sync_request (rate-limited), no penalty
 *   fork      → ignore + record (no ban: honest fork is not an attack)
 *   invalid   → penalty (caller decides how much)
 */
export function applyIncomingBlock(args: {
  chain: Chain;
  block: Block;
  peerId: string;
  tracker: SyncTracker;
  requestSync?: (fromHeight: number) => void;
  now?: number;
}): ApplyResult {
  const { chain, block, peerId, tracker } = args;
  const now = args.now ?? Date.now();
  tracker.noteHeight(peerId, block.header.height);
  const cls = classifyBlock(chain, blockRef(block));

  if (cls === "duplicate") return { action: "ignored", cls, reason: "already known" };
  if (cls === "fork") return { action: "ignored", cls, reason: "conflicts with local history (observed, not banned)" };
  if (cls === "gap") {
    const fromHeight = chain.height;
    if (args.requestSync && tracker.shouldRequest(peerId, fromHeight, now)) {
      tracker.noteRequest(peerId, fromHeight, now);
      args.requestSync(fromHeight);
      return { action: "sync", cls, fromHeight };
    }
    return { action: "ignored", cls, reason: "gap, sync already pending or peer backed off" };
  }

  // next
  try {
    chain.accept(block);
    tracker.noteSuccess(peerId, now);
    return { action: "applied", cls };
  } catch (e: any) {
    return { action: "reject", cls, reason: e.message };
  }
}
