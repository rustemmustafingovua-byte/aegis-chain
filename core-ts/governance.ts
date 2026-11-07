/**
 * AEGIS Governance — vote weighted by stake, anti-Sybil via humanity ticket
 * Proposal: upgrade, param change, treasury spend. Pass: >=2/3 stake for, humanity quorum.
 */
import type { Chain } from "./chain.js";
import { sha256 } from "./crypto.js";

export type Proposal = { id: string; title: string; action: string; proposer: string; createdAt: number; votesFor: bigint; votesAgainst: bigint; status: "open" | "passed" | "failed"; humanityVotes: number };
export class Governance {
  proposals = new Map<string, Proposal>();
  voters = new Map<string, Set<string>>(); // proposalId -> voter addr
  constructor(private chain: Chain) {}
  create(id: string, title: string, action: string, proposer: string) {
    if (this.proposals.has(id)) throw new Error("proposal exists");
    this.proposals.set(id, { id, title, action, proposer, createdAt: Date.now(), votesFor: 0n, votesAgainst: 0n, status: "open", humanityVotes: 0 });
  }
  vote(proposalId: string, voter: string, support: boolean) {
    const p = this.proposals.get(proposalId);
    if (!p || p.status !== "open") throw new Error("not open");
    const seen = this.voters.get(proposalId) ?? new Set<string>();
    if (seen.has(voter)) throw new Error("already voted (Sybil defense: 1 addr = 1 vote)");
    seen.add(voter);
    this.voters.set(proposalId, seen);
    const acc = this.chain.ledger.accounts.get(voter);
    if (!acc) throw new Error("no account");
    const humanity = acc.humanityScore ?? 50;
    if (support) p.votesFor += acc.stake; else p.votesAgainst += acc.stake;
    if (humanity >= 70) p.humanityVotes += 1;
  }
  tally(proposalId: string) {
    const p = this.proposals.get(proposalId);
    if (!p) return null;
    // total from ledger stake (validators set may be smaller than ledger stakes in tests)
    let total = this.chain.totalStake();
    let ledgerStake = 0n;
    for (const a of this.chain.ledger.accounts.values()) ledgerStake += a.stake;
    if (ledgerStake > total) total = ledgerStake;
    if (total === 0n) return p;
    const threshold = (total * 2n) / 3n;
    if (p.votesFor >= threshold && p.humanityVotes >= 2) p.status = "passed";
    else if (p.votesAgainst >= threshold) p.status = "failed";
    return p;
  }
  /** v1.5: executable proposals — passed action mutates chain (fee change, treasury mint). */
  executed = new Set<string>();
  execute(proposalId: string): { applied: string } {
    const p = this.proposals.get(proposalId);
    if (!p || p.status !== "passed") throw new Error("not passed");
    if (this.executed.has(proposalId)) return { applied: "already executed" };
    const action = p.action.trim().toLowerCase();
    if (action.startsWith("fee:")) {
      const bps = BigInt(action.slice(4));
      if (bps < 0n || bps > 1000n) throw new Error("fee bounds 0..1000bps");
      for (const pool of this.chain.ledger.pools.values()) pool.feeBps = bps;
      this.executed.add(proposalId);
      return { applied: `feeBps ${bps}` };
    }
    if (action.startsWith("mint:")) {
      const [, addr, amt] = p.action.split(":");
      if (!addr || !amt) throw new Error("bad mint action");
      this.chain.ledger.fund(addr, BigInt(amt));
      this.executed.add(proposalId);
      return { applied: `mint ${amt} -> ${addr}` };
    }
    if (action.startsWith("noop") || action.trim() === "") {
      this.executed.add(proposalId);
      return { applied: "noop" };
    }
    throw new Error("unknown action");
  }
}
