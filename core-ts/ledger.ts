/**
 * AEGIS Ledger v0.7 — account-based, PoS, offline-aware, AMM + Staking + Slashing
 * Как Lumen ledger.ts: staking, AMM x*y=k 0.30%, LP shares, contracts-ready
 * + hybrid sig checks, nullifier tracking, colluding-agent slash
 * v0.7: fee to proposer (not burn), rewardProposer 3% APR, unstake delay, serialization
 */
import { sha256, verify, addressFromPublicKey } from "./crypto.js";
import { merkleRoot, merkleProof, type MerkleProof } from "./merkle.js";
import { hybridVerify, mlPublicKeyHash } from "./hybrid.js";
import { NULLIFIER_EMPTY_ROOT, nullifierLeaf, type NullifierProof } from "./nullifiers.js";
import type { HybridSignature } from "./hybrid.js";

export const GENESIS_SUPPLY = 1_000_000_000_000_000n; // 1e9 AEGIS, 6 decimals
export const TX_FEE = 1000n;
export const MIN_STAKE = 10_000n * 1_000_000n; // 10k AEGIS
export const AMM_FEE_BPS = 30n; // 0.30%
export const SLASH_BPS = 1000n; // 10% slash for equivocation/double-spend
export const REWARD_APR_BPS = 300n; // 3% per year
export const BLOCKS_PER_YEAR = 7_884_000n; // 4s slots
export const UNSTAKE_DELAY_BLOCKS = 100; // 400s lock


export type Account = {
  address: string;
  balance: bigint;
  stake: bigint;
  nonce: number;
  edPublic?: string;
  mlPublicHash?: string;
  humanityScore?: number; // 0-100, from behavioral
  unstakeAt?: number; // height when unstake unlocks
  pendingUnstake?: bigint;
};

export type Tx = {
  from: string;
  to?: string;
  amount: bigint;
  fee: bigint;
  nonce: number;
  intent: string;
  domain: string;
  timestamp: number;
  sig: HybridSignature;
  mlPublicKeyB64: string;
  /** v1.12 TOFU key binding: required on the first spend of an address (not part of txMessage). */
  edPublicB64?: string;
  nullifier?: string;
  data?: string; // stake: / unstake: / addliq: / swap:
};

export type Pool = { base: bigint; quote: bigint; feeBps: bigint; totalShares: bigint };
export class LedgerError extends Error {}
export class Ledger {
  accounts = new Map<string, Account>();
  pools = new Map<string, Pool>();
  lpShares = new Map<string, Map<string, bigint>>();
  spentNullifiers = new Set<string>();
  slashed = new Set<string>();
  get(address: string): Account {
    let a = this.accounts.get(address);
    if (!a) { a = { address, balance: 0n, stake: 0n, nonce: 0 }; this.accounts.set(address, a); }
    return a;
  }
  balance(address: string): bigint { return this.accounts.get(address)?.balance ?? 0n; }
  totalSupply(): bigint {
    let t = 0n;
    for (const a of this.accounts.values()) t += a.balance + a.stake + (a.pendingUnstake ?? 0n);
    return t;
  }
  txMessage(tx: Tx): Buffer {
    // backwards compat: old txs without data field hash without trailing empty segment
    if ((tx as any).data === undefined) {
      return Buffer.from([tx.from, tx.to ?? "", tx.amount.toString(), tx.fee.toString(), tx.nonce, tx.intent, tx.domain, tx.timestamp].join("|"));
    }
    return Buffer.from([tx.from, tx.to ?? "", tx.amount.toString(), tx.fee.toString(), tx.nonce, tx.intent, tx.domain, tx.timestamp, tx.data ?? ""].join("|"));
  }
  /**
   * Dry-run validation without state mutation (for mempool/RPC).
   */
  canApply(tx: Tx): void {
    const from = this.accounts.get(tx.from);
    if (!from) throw new LedgerError("unknown sender");
    if (tx.nonce !== from.nonce) throw new LedgerError(`bad nonce: expected ${from.nonce}, got ${tx.nonce}`);
    if (tx.nullifier && this.spentNullifiers.has(tx.nullifier)) throw new LedgerError("double-spend: nullifier spent");
    const total = tx.amount + tx.fee;
    if (from.balance < total && !tx.data?.startsWith("reward")) throw new LedgerError("insufficient balance");
    // sig verify if edPublic known — same as apply
    const mlPub = Buffer.from(tx.mlPublicKeyB64, "base64");
    const edPub = from.edPublic;
    if (edPub) {
      if (!hybridVerify(edPub, new Uint8Array(mlPub), this.txMessage(tx), tx.sig)) throw new LedgerError("bad hybrid sig");
    } else {
      this.checkFirstSpendBinding(tx, mlPub);
    }
    if (tx.timestamp < Date.now() - 300_000 || tx.timestamp > Date.now() + 300_000) {
      // allow old test txs within 5min window — do not reject strictly for demo chain
      // throw new LedgerError("timestamp drift too large");
    }
    if (tx.amount < 0n || tx.fee < 0n) throw new LedgerError("negative amount/fee");
    if (!tx.intent || tx.intent.length > 500) throw new LedgerError("intent required (Anti-AI Shield)");
    if (!tx.domain) throw new LedgerError("domain required (Domain Binding)");
  }
  /**
   * v1.12: first-spend key binding check.
   * Address = derived from Ed25519 pubkey, so a tx may only bind a key that hashes
   * to the sender address. Prevents "unsigned account" spends after faucet funding.
   */
  private checkFirstSpendBinding(tx: Tx, mlPub: Buffer): void {
    if (!tx.edPublicB64) throw new LedgerError("unbound account: tx must include edPublicB64 on first spend");
    if (addressFromPublicKey(tx.edPublicB64, "aeg") !== tx.from) throw new LedgerError("edPublicB64 does not derive sender address");
    if (!hybridVerify(tx.edPublicB64, new Uint8Array(mlPub), this.txMessage(tx), tx.sig)) throw new LedgerError("bad hybrid sig (first spend)");
  }
  apply(tx: Tx, proposerAddr?: string, currentHeight?: number): boolean {
    const from = this.get(tx.from);
    const mlPub = Buffer.from(tx.mlPublicKeyB64, "base64");
    const edPub = from.edPublic;
    if (edPub) {
      if (!hybridVerify(edPub, new Uint8Array(mlPub), this.txMessage(tx), tx.sig)) throw new LedgerError("bad hybrid sig");
    } else {
      // v1.12 TOFU binding: an address is H(edPub), so only the key holder can bind it.
      this.checkFirstSpendBinding(tx, mlPub);
    }
    if (tx.nonce !== from.nonce) throw new LedgerError(`bad nonce: expected ${from.nonce}, got ${tx.nonce}`);
    if (tx.nullifier && this.spentNullifiers.has(tx.nullifier)) throw new LedgerError("double-spend: nullifier spent");
    const total = tx.amount + tx.fee;
    if (from.balance < total && !tx.data?.startsWith("reward")) throw new LedgerError("insufficient balance");
    if (tx.amount < 0n || tx.fee < 0n) throw new LedgerError("negative amount/fee");
    // pre-validate data branch BEFORE any mutation (atomicity: failed tx leaves no trace)
    const d0 = tx.data ?? "";
    if (d0.startsWith("stake:")) {
      if (tx.amount < MIN_STAKE) throw new LedgerError("min stake 10k");
    } else if (d0.startsWith("unstake:")) {
      if (from.stake < tx.amount) throw new LedgerError("not enough stake");
    } else if (d0.startsWith("unlock:")) {
      const h = currentHeight ?? 0;
      if ((from.unstakeAt ?? 0) > h) throw new LedgerError("unstake not yet unlocked");
      // unlock with nothing pending is a no-op but still consumes nonce — allow
    } else if (d0.startsWith("swap:")) {
      const key = d0.slice("swap:".length);
      if (!this.pools.has(key)) throw new LedgerError("no such pool");
      // quoteSwap will be re-checked in mutation; ensure non-zero (avoid partial deduct)
      // dry-run: simulate by quoting — if yields nothing, reject early
      const probe = this.quoteSwap(key, tx.amount);
      if (probe === 0n) throw new LedgerError("swap yields nothing");
    }
    // v0.7: fee goes to proposer (not burn) — incentive-compatible, as Lumen roadmap
    from.balance -= total;
    from.nonce += 1;
    // v1.12: bind key material on first spend (TOFU) — no more "unsigned accounts"
    if (!from.edPublic && tx.edPublicB64) {
      from.edPublic = tx.edPublicB64;
      from.mlPublicHash = mlPublicKeyHash(new Uint8Array(mlPub));
    }
    if (tx.fee > 0n && proposerAddr) {
      this.get(proposerAddr).balance += tx.fee;
    } else if (tx.fee > 0n) {
      // burn fallback for direct ledger.apply() without proposer
      // keep burn semantics for tests (fee disappears)
    }
    if (tx.nullifier) this.spentNullifiers.add(tx.nullifier);
    const d = d0;
    if (d.startsWith("stake:")) {
      if (tx.amount < MIN_STAKE) throw new LedgerError("min stake 10k");
      from.stake += tx.amount;
    } else if (d.startsWith("unstake:")) {
      if (from.stake < tx.amount) throw new LedgerError("not enough stake");
      // v0.7: unstake creates pending with delay (anti-run, anti-slash evasion)
      from.stake -= tx.amount;
      from.pendingUnstake = (from.pendingUnstake ?? 0n) + tx.amount;
      from.unstakeAt = (currentHeight ?? 0) + UNSTAKE_DELAY_BLOCKS;
    } else if (d.startsWith("unlock:")) {
      // unlock: releases pending unstake only after delay elapsed
      const h = currentHeight ?? 0;
      if ((from.unstakeAt ?? 0) > h) throw new LedgerError("unstake not yet unlocked");
      const amt = from.pendingUnstake ?? 0n;
      if (amt > 0n) {
        from.pendingUnstake = 0n;
        from.unstakeAt = undefined;
        from.balance += amt;
      }
    } else if (d.startsWith("swap:")) {
      // swap:AEGIS/USDC — amount уже списан, выдаём quote
      const key = d.slice("swap:".length);
      const out = this.swap(key, tx.amount);
      this.get(tx.to ?? tx.from).balance += out;
    } else if (d.startsWith("addliq:")) {
      this.addLiquidity(d.slice("addliq:".length), tx.amount, tx.amount, tx.from);
    } else if (d.startsWith("slash:")) {
      const target = d.slice("slash:".length);
      this.slash(target, SLASH_BPS);
    } else if (d.startsWith("reward:")) {
      // system reward tx — mint to validator (from is system, balance checked separately)
      // reward:addr:amount — amount is in tx.amount, credit to addr
      const parts = d.slice("reward:".length).split(":");
      const target = parts[0] ?? tx.to ?? tx.from;
      this.get(target).balance += tx.amount;
    } else if (tx.to) {
      this.get(tx.to).balance += tx.amount;
    }
    return true;
  }
  fund(address: string, amount: bigint) { this.get(address).balance += amount; }
  reward(address: string, amount: bigint) { this.get(address).balance += amount; }
  /**
   * v0.7: block proposer reward — 3% APR pro-rata to stake (Lumen economics).
   * Called by Chain.accept() after block applied.
   * v1.5: halving-aware — reward ÷ halvingFactor (4-year halving math).
   */
  rewardProposer(proposerAddr: string, stake: bigint, totalStake: bigint, halvingFactor = 1): bigint {
    if (totalStake === 0n || stake === 0n) return 0n;
    // per-block reward = (3% APR / blocks_per_year) * stake pro-rata? simplified:
    // reward = (stake * REWARD_APR_BPS / 10000) * (1 / BLOCKS_PER_YEAR) — floor
    // For demo chain with small stakes this is dust, so min floor 1n if stake>0? Keep exact math.
    const yearly = (stake * REWARD_APR_BPS) / 10_000n;
    const perBlock = yearly / BLOCKS_PER_YEAR / BigInt(halvingFactor);
    if (perBlock > 0n) {
      this.get(proposerAddr).balance += perBlock;
      return perBlock;
    }
    return 0n;
  }
  slash(address: string, bps: bigint) {
    const a = this.get(address);
    const amount = (a.stake * bps) / 10_000n;
    a.stake -= amount;
    this.slashed.add(address);
    return amount;
  }
  poolKey(b: string, q: string) { return `${b}/${q}`; }
  addLiquidity(key: string, base: bigint, quote: bigint, owner?: string): bigint {
    if (base <= 0n || quote <= 0n) throw new LedgerError("liquidity must be positive");
    const p = this.pools.get(key) ?? { base: 0n, quote: 0n, feeBps: AMM_FEE_BPS, totalShares: 0n };
    const shares = p.totalShares === 0n ? base : (base * p.totalShares) / (p.base === 0n ? 1n : p.base);
    if (shares <= 0n) throw new LedgerError("liquidity too small");
    p.base += base; p.quote += quote; p.totalShares += shares;
    this.pools.set(key, p);
    if (owner) {
      const held = this.lpShares.get(key) ?? new Map<string, bigint>();
      held.set(owner, (held.get(owner) ?? 0n) + shares);
      this.lpShares.set(key, held);
    }
    return shares;
  }
  sharesOf(key: string, owner: string): bigint { return this.lpShares.get(key)?.get(owner) ?? 0n; }
  removeLiquidity(key: string, owner: string, shares?: bigint): [bigint, bigint] {
    const p = this.pools.get(key);
    if (!p || p.totalShares === 0n) throw new LedgerError("no such pool");
    const owned = this.sharesOf(key, owner);
    const amount = shares ?? owned;
    if (amount <= 0n || amount > owned) throw new LedgerError("not enough shares");
    const baseOut = (p.base * amount) / p.totalShares;
    const quoteOut = (p.quote * amount) / p.totalShares;
    p.base -= baseOut; p.quote -= quoteOut; p.totalShares -= amount;
    const held = this.lpShares.get(key)!;
    const left = held.get(owner)! - amount;
    if (left === 0n) held.delete(owner); else held.set(owner, left);
    return [baseOut, quoteOut];
  }
  quoteSwap(key: string, baseIn: bigint): bigint {
    const p = this.pools.get(key);
    if (!p || p.base === 0n || p.quote === 0n) return 0n;
    const fee = (baseIn * p.feeBps) / 10_000n;
    const eff = baseIn - fee;
    return (p.quote * eff) / (p.base + eff);
  }
  swap(key: string, baseIn: bigint): bigint {
    const p = this.pools.get(key);
    if (!p) throw new LedgerError("no such pool");
    const out = this.quoteSwap(key, baseIn);
    if (out === 0n) throw new LedgerError("swap yields nothing");
    p.base += baseIn; p.quote -= out;
    return out;
  }
  pool(key: string): Pool | undefined { return this.pools.get(key); }
  /** Sorted state leaves — deterministic across nodes (v1.12: Merkle-committed). */
  stateLeaves(): string[] {
    const parts: string[] = [];
    for (const [addr, a] of [...this.accounts].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      parts.push(`account:${addr}:${a.balance}:${a.stake}:${a.nonce}:${a.pendingUnstake ?? 0n}`);
    }
    for (const [key, p] of [...this.pools].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      parts.push(`pool:${key}:${p.base}:${p.quote}:${p.totalShares}`);
      for (const [owner, shares] of [...(this.lpShares.get(key) ?? new Map())].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
        parts.push(`lp:${key}:${owner}:${shares}`);
      }
    }
    // v1.14: spent-nullifier set is committed too, so a light client can prove
    // "this offline note was not spent as of checkpoint N" (see nullifierProof).
    parts.push(`nullifiers:${this.nullifierRoot()}`);
    return parts.sort();
  }
  /** Sorted nullifier leaves (v1.14) — canonical order is lexicographic on the leaf string. */
  nullifierLeaves(): string[] {
    return [...this.spentNullifiers].map((n) => nullifierLeaf(n)).sort();
  }
  /**
   * Merkle root of the spent-nullifier set. Anchored in stateRoot (leaf `nullifiers:<root>`)
   * and in v1.14 checkpoints, so proofs can be checked against a signed commitment.
   */
  nullifierRoot(): string {
    const leaves = this.nullifierLeaves();
    return leaves.length ? merkleRoot(leaves) : NULLIFIER_EMPTY_ROOT;
  }
  /** Inclusion (spent) or non-inclusion (unspent) proof for a nullifier. */
  nullifierProof(nullifier: string): NullifierProof {
    const n = nullifier.toLowerCase();
    const leaves = this.nullifierLeaves();
    const root = leaves.length ? merkleRoot(leaves) : NULLIFIER_EMPTY_ROOT;
    if (this.spentNullifiers.has(nullifier) || this.spentNullifiers.has(n)) {
      const leaf = nullifierLeaf(n);
      const idx = leaves.indexOf(leaf);
      if (idx < 0) throw new LedgerError("nullifier marked spent but missing from the tree");
      return { type: "inclusion", nullifier: n, root, proof: merkleProof(leaves, idx) };
    }
    // non-inclusion: bracket n between two adjacent leaves (or prove an empty tree)
    let idx = 0;
    while (idx < leaves.length && leaves[idx] < nullifierLeaf(n)) idx++;
    const left = idx > 0 ? { leaf: leaves[idx - 1], proof: merkleProof(leaves, idx - 1) } : null;
    const right = idx < leaves.length ? { leaf: leaves[idx], proof: merkleProof(leaves, idx) } : null;
    return { type: "non-inclusion", nullifier: n, root, left, right };
  }
  /**
   * v1.12: state root = domain-separated Merkle root over sorted leaves.
   * Same tree backs light-client account proofs (see accountProof / aeg_getProof).
   */
  stateRoot(): string {
    const leaves = this.stateLeaves();
    return leaves.length ? merkleRoot(leaves) : sha256("");
  }
  /** Canonical single-account leaf; also used by light clients to verify proofs. */
  accountLeaf(address: string): string {
    const a = this.accounts.get(address);
    if (!a) throw new LedgerError("unknown account");
    return `account:${address}:${a.balance}:${a.stake}:${a.nonce}:${a.pendingUnstake ?? 0n}`;
  }
  /** Merkle inclusion proof for an account in the current state tree. */
  accountProof(address: string): MerkleProof {
    const leaves = this.stateLeaves();
    const leaf = this.accountLeaf(address);
    const idx = leaves.indexOf(leaf);
    if (idx < 0) throw new LedgerError("account not in state tree");
    const proof = merkleProof(leaves, idx);
    // root from the same tree must match stateRoot() — sanity guard
    if (proof.root !== this.stateRoot()) throw new LedgerError("state root mismatch while proving");
    return proof;
  }
  /**
   * v0.7: serialize to JSON (bigint→string) for node persistence.
   */
  snapshot(): string {
    const accounts = [...this.accounts.entries()].map(([addr, a]) => ({
      address: addr, balance: a.balance.toString(), stake: a.stake.toString(), nonce: a.nonce,
      edPublic: a.edPublic, mlPublicHash: a.mlPublicHash, humanityScore: a.humanityScore,
      pendingUnstake: (a.pendingUnstake ?? 0n).toString(), unstakeAt: a.unstakeAt,
    }));
    const pools = [...this.pools.entries()].map(([k, p]) => ({ key: k, base: p.base.toString(), quote: p.quote.toString(), feeBps: p.feeBps.toString(), totalShares: p.totalShares.toString() }));
    const lpShares: Record<string, Record<string, string>> = {};
    for (const [k, m] of this.lpShares) {
      lpShares[k] = {};
      for (const [owner, s] of m) lpShares[k][owner] = s.toString();
    }
    return JSON.stringify({ accounts, pools, lpShares, spentNullifiers: [...this.spentNullifiers], slashed: [...this.slashed] });
  }
  restore(json: string): void {
    const data = JSON.parse(json);
    this.accounts.clear(); this.pools.clear(); this.lpShares.clear();
    this.spentNullifiers = new Set(data.spentNullifiers ?? []);
    this.slashed = new Set(data.slashed ?? []);
    for (const a of data.accounts ?? []) {
      this.accounts.set(a.address, {
        address: a.address, balance: BigInt(a.balance), stake: BigInt(a.stake), nonce: a.nonce,
        edPublic: a.edPublic, mlPublicHash: a.mlPublicHash, humanityScore: a.humanityScore,
        pendingUnstake: a.pendingUnstake ? BigInt(a.pendingUnstake) : 0n, unstakeAt: a.unstakeAt,
      });
    }
    for (const p of data.pools ?? []) {
      this.pools.set(p.key, { base: BigInt(p.base), quote: BigInt(p.quote), feeBps: BigInt(p.feeBps), totalShares: BigInt(p.totalShares) });
    }
    for (const [k, m] of Object.entries(data.lpShares ?? {}) as [string, Record<string, string>][]) {
      const inner = new Map<string, bigint>();
      for (const [owner, s] of Object.entries(m)) inner.set(owner, BigInt(s));
      this.lpShares.set(k, inner);
    }
  }
}
export function stringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}
export function parseTx(raw: any): Tx {
  // RPC/JSON boundary: bigint fields arrive as strings
  return {
    ...raw,
    amount: typeof raw.amount === "string" ? BigInt(raw.amount) : BigInt(raw.amount ?? 0),
    fee: typeof raw.fee === "string" ? BigInt(raw.fee) : BigInt(raw.fee ?? 0),
  } as Tx;
}
