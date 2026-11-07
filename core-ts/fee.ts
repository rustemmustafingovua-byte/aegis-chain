/**
 * AEGIS Fee Market v1.12 — EIP-1559-lite base fee for a 4s-slot PoS chain.
 *
 * Why: fixed 1000-base-unit fee is trivially spam-able and gives agents no
 * price signal. A moving base fee makes block space a market and gives wallets
 * an honest `aeg_gasPrice` to quote.
 *
 * Rules (mempool policy, not consensus — old blocks stay valid):
 *  - baseFee starts at TX_FEE (1000) at genesis, floor 1.
 *  - target = maxTxs / 2.
 *  - full blocks: baseFee += baseFee * (txCount - target) / target / 8  (≤ +12.5%/block)
 *  - empty blocks: baseFee -= baseFee * (target - txCount) / target / 8 (≤ -12.5%/block)
 *  - hard cap 1e9 base units to bound DoS via sustained spam (documented).
 *
 * The proposer still receives the full fee (v0.7 economics); burn can be enabled
 * with AEGIS_BURN_FEE=on for a supply-deflationary profile.
 */
import { TX_FEE } from "./ledger.js";

export const BASE_FEE_FLOOR = 1n;
export const BASE_FEE_CAP = 1_000_000_000n; // 1000 AEGIS per tx max base fee
export const DEFAULT_PRIORITY_FEE = 1000n; // wallet tip suggestion

export type FeeSample = { height: number; baseFee: string; txCount: number; utilization: number };

export class FeeMarket {
  baseFee: bigint = TX_FEE;
  history: FeeSample[] = [];
  historyLimit = 64;

  /** Apply one block to the fee state. Returns the new base fee. */
  update(txCount: number, maxTxs: number, height = 0): bigint {
    const target = Math.max(1, Math.floor(maxTxs / 2));
    const prev = this.baseFee;
    if (txCount > target) {
      const delta = (prev * BigInt(txCount - target)) / BigInt(target) / 8n;
      this.baseFee = prev + (delta > 0n ? delta : 1n); // never stall at 0 growth
    } else if (txCount < target) {
      const delta = (prev * BigInt(target - txCount)) / BigInt(target) / 8n;
      this.baseFee = prev - delta;
    }
    if (this.baseFee < BASE_FEE_FLOOR) this.baseFee = BASE_FEE_FLOOR;
    if (this.baseFee > BASE_FEE_CAP) this.baseFee = BASE_FEE_CAP;
    this.history.push({
      height,
      baseFee: this.baseFee.toString(),
      txCount,
      utilization: Math.min(1, txCount / Math.max(1, maxTxs)),
    });
    if (this.history.length > this.historyLimit) this.history.shift();
    return this.baseFee;
  }

  /** Suggested max fee for a normal tx (base + tip). */
  suggest(): bigint {
    return this.baseFee + DEFAULT_PRIORITY_FEE;
  }

  /** Is a tx fee acceptable under current policy? */
  accepts(fee: bigint): boolean {
    return fee >= this.baseFee;
  }

  /** Median-of-last-N base fee — smooths one-block noise for wallets. */
  median(window = 9): bigint {
    const slice = this.history.slice(-window).map((s) => BigInt(s.baseFee)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (!slice.length) return this.baseFee;
    return slice[Math.floor(slice.length / 2)];
  }

  toJSON() {
    return { baseFee: this.baseFee.toString(), history: this.history };
  }

  static fromJSON(j: any): FeeMarket {
    const f = new FeeMarket();
    if (!j) return f;
    try {
      if (j.baseFee !== undefined) f.baseFee = BigInt(j.baseFee);
    } catch { /* keep default */ }
    if (Array.isArray(j.history)) f.history = j.history.slice(-f.historyLimit);
    return f;
  }
}
