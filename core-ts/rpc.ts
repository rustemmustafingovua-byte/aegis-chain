/**
 * AEGIS RPC v1.1 — JSON-RPC 2.0 поверх HTTP (как Lumen)
 * Методы: aeg_getState, aeg_getBlock, aeg_getBalance, aeg_sendTx, aeg_meshStatus, aeg_sync
 * v0.7: aeg_sendTx validates (canApply) before mempool, + pool/stake/gov/bridge methods
 * v1.1: + aeg_faucet (devnet), aeg_registerValidator, aeg_metrics / /metrics, libp2p gossip
 */
import * as http from "node:http";
import { createHash } from "node:crypto";
import { Chain } from "./chain.js";
import { stringify, parseTx } from "./ledger.js";
import { MeshNode } from "./mesh.js";
import { Governance } from "./governance.js";
import { Bridge } from "./bridge.js";
import type { P2pNode } from "./p2p.js";
import type { Libp2pNode } from "./libp2p.js";
import { verifyMerkleProof, merkleProof, type MerkleProof } from "./merkle.js";
import {
  PasskeyRegistry, verifyRegistration, verifyAssertion, challengeFromHex, defaultOrigins, defaultRpId,
} from "./webauthn.js";
import { hybridVerify, type HybridKeypair } from "./hybrid.js";
import { VERSION } from "./version.js";
import { WAL_SNAPSHOT_EVERY } from "./wal.js";
import { headerFromBlock, validatorViewOf, verifyHeaderChain } from "./headers.js";
import { CheckpointStore, createCheckpoint, coSign, verifyCheckpoint, type Checkpoint } from "./checkpoints.js";
import { verifyNullifierProof, type NullifierProof } from "./nullifiers.js";

type RpcRequest = { jsonrpc: string; id: number | string; method: string; params: any[] };
type RpcResponse = { jsonrpc: "2.0"; id: number | string; result?: unknown; error?: { code: number; message: string } };

export type RpcDeps = {
  gov?: Governance; bridge?: Bridge; p2p?: P2pNode; libp2p?: Libp2pNode;
  passkeys?: PasskeyRegistry;
  /** v1.13 light client: signed state checkpoints */
  checkpoints?: CheckpointStore;
  /** node validator keys, used to co-sign checkpoints on request */
  validator?: HybridKeypair;
  /** persist the checkpoint store after a new signature (server wires this to disk) */
  saveCheckpoints?: () => void;
};

const ADMIN_METHODS = new Set(["aeg_faucet", "aeg_slash", "aeg_registerValidator", "aeg_commitMlKey", "aeg_prune", "aeg_checkpoint", "aeg_checkpointSign"]);

export function createRpcServer(chain: Chain, mesh?: MeshNode, deps: RpcDeps = {}) {
  // per-IP token bucket rate limit (100 req/s default, env AEGIS_RPC_RATE_LIMIT)
  const rateWindow = new Map<string, { count: number; ts: number }>();
  const RATE_LIMIT = Number(process.env.AEGIS_RPC_RATE_LIMIT ?? 100);
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, x-admin-token");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    // rate limit
    const ip = (req.socket.remoteAddress ?? "unknown").split(",")[0].trim();
    const nowSec = Math.floor(Date.now() / 1000);
    const slot = rateWindow.get(ip) ?? { count: 0, ts: nowSec };
    if (slot.ts !== nowSec) rateWindow.set(ip, { count: 1, ts: nowSec });
    else if (++slot.count > RATE_LIMIT) {
      res.writeHead(429, { "Retry-After": String(60 - (Date.now() % 60_000) / 1000), "Content-Type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32002, message: "rate limit exceeded" } }));
    }

    if (req.url === "/health") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: true, height: chain.height, version: VERSION })); }
    if (req.url === "/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      const lines = [
        `aegis_height ${chain.height}`,
        `aegis_mempool ${chain.mempool.size}`,
        `aegis_blocks ${chain.blocks.length}`,
        `aegis_accounts ${chain.ledger.accounts.size}`,
        `aegis_validators ${chain.validators.size}`,
        `aegis_supply ${chain.ledger.totalSupply().toString()}`,
        `aegis_state_root "${chain.ledger.stateRoot()}"`,
        `aegis_uptime_seconds ${Math.floor(process.uptime())}`,
      ];
      return res.end(lines.join("\n") + "\n");
    }
    if (req.url === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const pools = [...chain.ledger.pools.entries()].map(([key, p]) => ({
        key, base: p.base.toString(), quote: p.quote.toString(), feeBps: p.feeBps.toString(),
        totalShares: p.totalShares.toString(),
        price: p.base > 0n ? (Number(p.quote) / Number(p.base)).toFixed(6) : "0",
      }));
      const proposals = deps.gov ? [...deps.gov.proposals.values()].map((p) => ({
        id: p.id, title: p.title, action: p.action, proposer: p.proposer, status: p.status,
        votesFor: p.votesFor.toString(), votesAgainst: p.votesAgainst.toString(), humanityVotes: p.humanityVotes,
      })) : [];
      const peers = deps.p2p ? deps.p2p.peerList() : [];
      return res.end(JSON.stringify({
        height: chain.height,
        head: chain.head ? { hash: chain.head.hash, height: chain.head.header.height, txCount: chain.head.header.txCount } : null,
        mempool: chain.mempool.size,
        supply: chain.ledger.totalSupply().toString(),
        stateRoot: chain.ledger.stateRoot(),
        nullifierRoot: chain.ledger.nullifierRoot(),
        baseFee: chain.feeMarket.baseFee.toString(),
        suggestedFee: chain.feeMarket.suggest().toString(),
        version: VERSION,
        passkeys: deps.passkeys ? deps.passkeys.byCredential.size : 0,
        checkpoint: (() => {
          const cp = deps.checkpoints?.latest();
          if (!cp) return null;
          const v = verifyCheckpoint(cp, validatorViewOf(chain));
          return {
            height: cp.height, stateRoot: cp.stateRoot, nullifierRoot: cp.nullifierRoot,
            signedBps: v.signedBps, signers: v.signers.length,
          };
        })(),
        validators: [...chain.validators.values()].map((v) => ({ edPublic: v.publicKey.slice(0, 20) + "…", stake: v.stake.toString(), address: v.address ?? null })),
        accounts: [...chain.ledger.accounts.entries()].map(([addr, a]) => ({ addr, balance: a.balance.toString(), stake: a.stake.toString(), nonce: a.nonce, humanityScore: a.humanityScore ?? null })),
        pools,
        proposals,
        peers,
        blocks: chain.blocks.slice(-20).map((b) => ({ height: b.header.height, hash: b.hash.slice(0, 16), txCount: b.header.txCount, timestamp: b.header.timestamp, proposer: b.header.proposer.slice(0, 12) + "…" })),
      }));
    }
    if (req.method !== "POST" || !(req.url === "/api/rpc" || req.url === "/rpc")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "not found" }));
    }
    let body = "";
    let bytes = 0;
    req.on("data", (c) => { bytes += c.length; if (bytes > 1_048_576) { res.writeHead(413, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "body too large" } })); req.destroy(); return; } body += c; });
    req.on("end", () => {
      if (bytes > 1_048_576) return;
      try {
        const reqJson = JSON.parse(body) as RpcRequest;
        if (!reqJson.method || typeof reqJson.method !== "string") throw new Error("bad method");
        if (!Array.isArray(reqJson.params)) throw new Error("bad params");
        const adminTok = (req.headers["x-admin-token"] as string) ?? "";
        const expected = process.env.AEGIS_ADMIN_TOKEN ?? "";
        if (ADMIN_METHODS.has(reqJson.method) && expected && adminTok !== expected) {
          throw new Error("admin token required (AEGIS_ADMIN_TOKEN)");
        }
        const result = dispatch(reqJson.method, reqJson.params || []);
        const resp: RpcResponse = { jsonrpc: "2.0", id: reqJson.id, result };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(resp));
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: e.message } }));
      }
    });
  });

  function sha256Hex(buf: Buffer): string {
    return createHash("sha256").update(buf).digest("hex");
  }

  function dispatch(method: string, params: any[]) {
    switch (method) {
      case "aeg_getState": return {
        height: chain.height, head: chain.head?.hash ?? null,
        supply: chain.ledger.totalSupply().toString(),
        stateRoot: chain.ledger.stateRoot(), nullifierRoot: chain.ledger.nullifierRoot(),
      };
      case "aeg_getBlock": {
        const h = params[0] as number;
        const b = chain.blocks.find((x) => x.header.height === h);
        return b ? JSON.parse(stringify(b)) : null;
      }
      case "aeg_getBlocks": {
        // backward compat: [limit] = last N; [offset, limit] = paginated window
        if (params.length >= 2) {
          const offset = Number(params[0] ?? 0);
          const limit = Math.min(Number(params[1] ?? 20), 100);
          return chain.blocks.slice(offset, offset + limit).map((b) => ({ height: b.header.height, hash: b.hash, txCount: b.header.txCount }));
        }
        return chain.blocks.slice(-(Number(params[0] ?? 20))).map((b) => ({ height: b.header.height, hash: b.hash, txCount: b.header.txCount }));
      }
      case "aeg_getBalance": return chain.ledger.balance(params[0] as string).toString();
      case "aeg_getAccount": {
        const a = chain.ledger.accounts.get(params[0] as string);
        return a ? { address: a.address, balance: a.balance.toString(), stake: a.stake.toString(), nonce: a.nonce, humanityScore: a.humanityScore ?? null, pendingUnstake: (a.pendingUnstake ?? 0n).toString() } : null;
      }
      case "aeg_sendTx": {
        // v0.7: validate before mempool (was blind add — spam vector)
        const tx = parseTx(params[0]);
        // v1.12: fee market admission policy (wallet must quote aeg_gasPrice)
        if (tx.fee < chain.feeMarket.baseFee) {
          throw new Error(`fee ${tx.fee} below base fee ${chain.feeMarket.baseFee} (use aeg_gasPrice)`);
        }
        chain.ledger.canApply(tx);
        // v1.12: accounts with a bound passkey must present a fresh WebAuthn assertion
        // over the exact tx message — phishing/agent replay cannot satisfy this.
        if (deps.passkeys?.has(tx.from)) {
          const assertion = params[1];
          if (!assertion || typeof assertion !== "object") throw new Error("passkey assertion required for this account");
          const binding = deps.passkeys.get(assertion.credentialId);
          if (!binding || binding.address !== tx.from) throw new Error("passkey credential is not bound to sender");
          const challengeHex = sha256Hex(chain.ledger.txMessage(tx));
          const res = verifyAssertion({
            clientDataJSON: assertion.clientDataJSON,
            authenticatorData: assertion.authenticatorData,
            signature: assertion.signature,
            expectedChallenge: challengeFromHex(challengeHex),
            expectedOrigin: defaultOrigins(),
            expectedRpId: defaultRpId(),
            publicKeyJwk: binding.publicKeyJwk,
            storedCounter: binding.counter,
            requireUserVerification: false,
          });
          if (!res.ok) throw new Error(`passkey assertion rejected: ${res.reason}`);
          deps.passkeys.touch(assertion.credentialId, res.newCounter);
        }
        chain.mempool.add(tx);
        // gossip to peers if attached (dual transport)
        try { deps.p2p?.gossipTx(tx); } catch {}
        try { (deps as any).libp2p?.gossipTx(tx); } catch {}
        // real tx id (message hash), not the state root — wallets show this in history
        return { accepted: true, mempool: chain.mempool.size, txHash: sha256Hex(Buffer.from(stringify(tx))).slice(0, 16) };
      }
      case "aeg_swapQuote": {
        const [key, amount] = [params[0] as string, params[1]];
        const out = chain.ledger.quoteSwap(key, BigInt(amount));
        return { key, amountIn: amount.toString(), amountOut: out.toString() };
      }
      case "aeg_poolInfo": {
        const p = params[0] ? chain.ledger.pool(params[0] as string) : [...chain.ledger.pools.values()][0];
        return p ? { base: p.base.toString(), quote: p.quote.toString(), feeBps: p.feeBps.toString(), totalShares: p.totalShares.toString() } : null;
      }
      case "aeg_govPropose": {
        if (!deps.gov) throw new Error("governance not attached");
        const [id, title, action, proposer] = params as string[];
        deps.gov.create(id, title, action, proposer);
        return { created: id };
      }
      case "aeg_govVote": {
        if (!deps.gov) throw new Error("governance not attached");
        const [id, voter, support] = params as [string, string, boolean];
        deps.gov.vote(id, voter, !!support);
        const p = deps.gov.tally(id);
        return p ? JSON.parse(stringify(p)) : null;
      }
      case "aeg_govList": {
        if (!deps.gov) return [];
        return [...deps.gov.proposals.values()].map((p) => JSON.parse(stringify(p)));
      }
      case "aeg_govExecute": {
        if (!deps.gov) throw new Error("governance not attached");
        return deps.gov.execute(params[0] as string);
      }
      case "aeg_bridgeQuote": {
        const [usdcIn, ammBase, ammQuote] = [params[0], params[1], params[2]];
        if (!deps.bridge) throw new Error("bridge not attached");
        const out = deps.bridge.quoteBaseToAegis(BigInt(usdcIn), BigInt(ammBase), BigInt(ammQuote));
        return { usdcIn: usdcIn.toString(), aegisOut: out.toString() };
      }
      case "aeg_validatorList": return [...chain.validators.entries()].map(([pk, v]) => ({ edPublic: pk, stake: v.stake.toString(), address: v.address ?? null }));
      case "aeg_peerList": return deps.p2p ? deps.p2p.peerList() : [];
      // v1.16: sync/fork observability — is the node actually catching up?
      case "aeg_syncStatus": {
        const tcp = deps.p2p?.syncStatus ? deps.p2p.syncStatus() : null;
        const lib = (deps as any).libp2p?.syncStatus ? (deps as any).libp2p.syncStatus() : null;
        return { height: chain.height, head: chain.head?.hash ?? null, tcp, libp2p: lib };
      }
      case "aeg_libp2pPeers": return (deps as any).libp2p ? (deps as any).libp2p.peerList() : [];
      case "aeg_meshStatus": return mesh ? { mempool: mesh.mempool.size, peers: [...mesh.peers], stats: mesh.stats, snapshot: mesh.snapshot } : { mesh: "not attached" };
      case "aeg_faucet": {
        // devnet faucet — disabled in prod (mainnet custody). Rate-limited per address.
        if (process.env.AEGIS_FAUCET === "off") throw new Error("faucet disabled");
        const [addr, amountRaw] = params as [string, string?];
        if (!addr || !addr.startsWith("aeg1")) throw new Error("bad address");
        const amount = BigInt(amountRaw ?? "10000000000"); // default 10k AEGIS
        if (amount <= 0n || amount > 1_000_000_000_000n) throw new Error("bad amount");
        const acct = chain.ledger.get(addr);
        if ((acct as any)._faucetCount > 5) throw new Error("faucet rate limit (5/address)");
        (acct as any)._faucetCount = ((acct as any)._faucetCount ?? 0) + 1;
        chain.ledger.fund(addr, amount);
        return { funded: addr, amount: amount.toString(), balance: chain.ledger.balance(addr).toString() };
      }
      case "aeg_registerValidator": {
        const [edPublic, mlPublicKeyB64, stakeRaw, address] = params as [string, string, string, string?];
        if (!edPublic || !mlPublicKeyB64) throw new Error("bad keys");
        const stake = BigInt(stakeRaw);
        if (stake < 10_000n * 1_000_000n) throw new Error("min stake 10k AEGIS");
        if (address) {
          const bal = chain.ledger.balance(address);
          if (bal < stake) throw new Error("insufficient balance for stake");
        }
        chain.addValidator(edPublic, mlPublicKeyB64, stake, address);
        return { registered: edPublic.slice(0, 20) + "…", stake: stake.toString() };
      }
      case "aeg_slash": {
        const [addr, bpsRaw] = params as [string, string?];
        if (!addr || !addr.startsWith("aeg1")) throw new Error("bad address");
        const bps = BigInt(bpsRaw ?? "1000");
        if (bps <= 0n || bps > 10000n) throw new Error("bad bps");
        const cut = chain.ledger.slash(addr, bps);
        return { slashed: addr, bps: bps.toString(), cut: cut.toString() };
      }
      case "aeg_metrics": return { height: chain.height, mempool: chain.mempool.size, blocks: chain.blocks.length, validators: chain.validators.size, uptime: Math.floor(process.uptime()) };
      case "aeg_walStatus": return { wal: "aegis-chain.wal.ndjson", height: chain.height, blocks: chain.blocks.length, snapshotEvery: WAL_SNAPSHOT_EVERY };
      case "aeg_finality": return { finalized: chain.isFinalized(), height: chain.height, totalStake: chain.totalStake().toString() };
      case "aeg_halving": return { height: chain.height, halvingFactor: chain.halvingFactor(), halvingEvery: 7_884_000 * 4 };
      case "aeg_snapshot": return chain.snapshot();
      case "aeg_checkpoint": {
        // v1.6: checkpoint = snapshot + prune to 100 + WAL compact (single call)
        chain.prune(100);
        return { checkpoint: chain.snapshot(), prunedHeight: chain.prunedHeight };
      }
      case "aeg_validatorStats": {
        const edPub = params[0] as string;
        const v = chain.validators.get(edPub);
        return v ? { edPublic: edPub, stake: v.stake.toString(), address: v.address ?? null, proposed: chain.proposerCounts.get(edPub) ?? 0, halvingFactor: chain.halvingFactor() } : null;
      }
      case "aeg_commitMlKey": {
        // v1.8: PQ hash commitment — store mlPublicHash for account (full 1952B key off-chain, hash on-chain)
        const [addr, mlHash, mlPublicKeyB64] = params as [string, string, string?];
        if (!addr || !addr.startsWith("aeg1")) throw new Error("bad address");
        if (!mlHash || mlHash.length !== 64) throw new Error("bad mlHash (sha256 hex)");
        const acct = chain.ledger.get(addr);
        if (mlPublicKeyB64) {
          const pub = Buffer.from(mlPublicKeyB64, "base64");
          if (pub.length !== 1952) throw new Error("ml pub must be 1952B");
          const h = createHash("sha256").update(pub).digest("hex");
          if (h !== mlHash) throw new Error("hash mismatch");
        }
        acct.mlPublicHash = mlHash;
        return { committed: addr, mlPublicHash: mlHash };
      }
      case "aeg_prune": return { prunedHeight: chain.prune(Number(params[0] ?? 100)) };
      case "aeg_sync": return { height: chain.height, blocks: chain.blocks.length, stateRoot: chain.ledger.stateRoot() };

      // ---- v1.13: light client (headers, tx proofs, signed checkpoints) ----
      case "aeg_getHeaders": {
        const from = Number(params[0] ?? 0);
        const to = Number(params[1] ?? from + 20);
        if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) throw new Error("bad header range");
        if (to - from > 100) throw new Error("header range too large (max 100)");
        return chain.blocks
          .filter((b) => b.header.height >= from && b.header.height <= to)
          .map((b) => headerFromBlock(b));
      }
      case "aeg_verifyHeaders": {
        // convenience: node verifies a batch for a client (client MUST re-verify if it cares)
        const headers = params[0];
        if (!Array.isArray(headers)) throw new Error("headers must be an array");
        return verifyHeaderChain(headers, validatorViewOf(chain), {
          expectedPrevHash: params[1]?.prevHash, expectedHeight: params[1]?.height,
        });
      }
      case "aeg_getTxProof": {
        const height = Number(params[0]);
        const index = Number(params[1] ?? 0);
        const b = chain.blocks.find((x) => x.header.height === height);
        if (!b) throw new Error(`no block at height ${height}`);
        if (!Number.isInteger(index) || index < 0 || index >= b.txs.length) throw new Error("tx index out of range");
        const leaves = b.txs.map((t) => sha256Hex(Buffer.from(stringify(t))));
        const proof = merkleProof(leaves, index);
        if (proof.root !== b.header.merkleRoot) throw new Error("merkle root mismatch (corrupt block)");
        return { tx: JSON.parse(stringify(b.txs[index])), proof, header: b.header, blockHash: b.hash };
      }
      case "aeg_validatorSet": {
        const view = validatorViewOf(chain);
        return [...view.entries()].map(([edPublic, v]) => ({
          edPublic, publicKey: v.publicKey, mlPublicKeyB64: v.mlPublicKeyB64, stake: v.stake.toString(), address: v.address ?? null,
        }));
      }
      case "aeg_checkpointLatest": {
        const cp = deps.checkpoints?.latest();
        if (!cp) return null;
        return { checkpoint: cp, verification: verifyCheckpoint(cp, validatorViewOf(chain)) };
      }
      case "aeg_getCheckpoints": {
        if (!deps.checkpoints) return [];
        return deps.checkpoints.list(Number(params[0] ?? 0), Math.min(Number(params[1] ?? 50), 200));
      }
      // ---- v1.14: nullifier (non-)inclusion — офлайн-проверка «не потрачено» ----
      case "aeg_getNullifierRoot": return { height: chain.height, nullifierRoot: chain.ledger.nullifierRoot() };
      case "aeg_isNullifierSpent": {
        const nullifier = String(params[0] ?? "");
        if (!nullifier) throw new Error("nullifier required");
        const proof = chain.ledger.nullifierProof(nullifier);
        const check = verifyNullifierProof(proof);
        const cp = deps.checkpoints?.latest() ?? null;
        return {
          nullifier, spent: chain.ledger.spentNullifiers.has(nullifier) || chain.ledger.spentNullifiers.has(nullifier.toLowerCase()),
          proof, verified: check.ok,
          // what a light client should compare against: the latest signed checkpoint
          anchor: cp ? { height: cp.height, nullifierRoot: cp.nullifierRoot } : null,
          reason: check.ok ? undefined : (check as any).reason,
        };
      }
      // v1.16: co-sign a peer's checkpoint — only for OUR tip, only the state we see.
      // Refusing a stale offer is the point: a signature must attest to verified state.
      case "aeg_checkpointOffer": {
        if (!deps.checkpoints || !deps.validator) throw new Error("checkpoint signing not configured");
        const offered = params[0] as Checkpoint;
        if (!offered || (offered as any).version !== 2) throw new Error("bad checkpoint");
        if (offered.height !== chain.height) return { signed: false, reason: `not at tip (offer ${offered.height}, local ${chain.height})` };
        if (offered.blockHash !== (chain.head?.hash ?? "")) return { signed: false, reason: "block hash mismatch" };
        if (offered.stateRoot !== chain.ledger.stateRoot()) return { signed: false, reason: "state root mismatch" };
        if (offered.nullifierRoot !== chain.ledger.nullifierRoot()) return { signed: false, reason: "nullifier root mismatch" };
        const signed = coSign(JSON.parse(JSON.stringify(offered)) as Checkpoint, deps.validator);
        deps.checkpoints.add(signed);
        try { deps.saveCheckpoints?.(); } catch { /* best effort */ }
        return { signed: true, checkpoint: signed, verification: verifyCheckpoint(signed, validatorViewOf(chain)) };
      }
      case "aeg_checkpointSign": {
        if (!deps.checkpoints || !deps.validator) throw new Error("checkpoint signing not configured");
        const cp = createCheckpoint(chain, deps.validator);
        deps.checkpoints.add(cp);
        try { deps.saveCheckpoints?.(); } catch { /* best effort, signature still in memory */ }
        return { checkpoint: cp, verification: verifyCheckpoint(cp, validatorViewOf(chain)) };
      }

      // ---- v1.12: fee market ----
      case "aeg_gasPrice": {
        return {
          baseFee: chain.feeMarket.baseFee.toString(),
          priorityFee: "1000",
          suggestedMaxFee: chain.feeMarket.suggest().toString(),
          median: chain.feeMarket.median().toString(),
        };
      }
      case "aeg_feeHistory": {
        const n = Math.min(Number(params[0] ?? 10), 64);
        return chain.feeMarket.history.slice(-n);
      }

      // ---- v1.12: light-client state proofs ----
      case "aeg_getProof": {
        const address = params[0] as string;
        if (!address || !address.startsWith("aeg1")) throw new Error("bad address");
        const proof: MerkleProof = chain.ledger.accountProof(address);
        return { ...proof, height: chain.height, stateRoot: chain.ledger.stateRoot(), verified: verifyMerkleProof(proof) };
      }

      // ---- v1.12: passkey (WebAuthn) binding ----
      case "aeg_passkeyRegister": {
        if (!deps.passkeys) throw new Error("passkey registry not attached");
        const [address, credentialId, clientDataJSON, attestationObject, proof, mlPublicKeyB64, label] =
          params as [string, string, string, string, any, string, string?];
        if (!address?.startsWith("aeg1")) throw new Error("bad address");
        if (!credentialId || !clientDataJSON || !attestationObject) throw new Error("missing webauthn payload");
        const acct = chain.ledger.get(address);
        if (!acct.edPublic) throw new Error("account has no bound Ed25519 key yet (send one tx first)");
        if (!proof?.edSig || !proof?.mlSig || typeof proof?.hybrid !== "string") throw new Error("missing binding proof");
        // 1) owner proof: hybrid signature over the deterministic binding message
        const bindingMsg = Buffer.from(`aegis-passkey-bind|${address}|${credentialId}`);
        const mlPub = Buffer.from(mlPublicKeyB64 ?? "", "base64");
        if (!hybridVerify(acct.edPublic, new Uint8Array(mlPub), bindingMsg, proof)) throw new Error("binding proof: bad hybrid signature");
        if (acct.mlPublicHash) {
          const h = createHash("sha256").update(mlPub).digest("hex");
          if (h !== acct.mlPublicHash) throw new Error("binding proof: ML-DSA key does not match account commitment");
        }
        // 2) WebAuthn registration ceremony (challenge = H(bindingMsg))
        const expectedChallenge = challengeFromHex(createHash("sha256").update(bindingMsg).digest("hex"));
        const reg = verifyRegistration({
          clientDataJSON, attestationObject, expectedChallenge,
          expectedOrigin: defaultOrigins(), expectedRpId: defaultRpId(),
        });
        if (reg.credentialId !== credentialId) throw new Error("credentialId mismatch in attestation");
        // 3) no cross-account rebinding
        const existing = deps.passkeys.get(credentialId);
        if (existing && existing.address !== address) throw new Error("credential already bound to another address");
        deps.passkeys.bind({
          address, credentialId, publicKeyJwk: reg.publicKeyJwk, alg: reg.alg,
          counter: reg.counter, createdAt: Date.now(), label,
        });
        return { bound: true, address, credentialId, alg: reg.alg };
      }
      case "aeg_passkeyInfo": {
        if (!deps.passkeys) throw new Error("passkey registry not attached");
        return deps.passkeys.forAddress(params[0] as string).map((b) => ({
          credentialId: b.credentialId, alg: b.alg, counter: b.counter, label: b.label ?? null,
          createdAt: b.createdAt, lastUsedAt: b.lastUsedAt ?? null,
        }));
      }
      case "aeg_passkeyRevoke": {
        if (!deps.passkeys) throw new Error("passkey registry not attached");
        const [address, credentialId] = params as [string, string];
        const b = deps.passkeys.get(credentialId);
        if (!b || b.address !== address) throw new Error("credential not bound to address");
        return { revoked: deps.passkeys.unbind(credentialId) };
      }
      default: throw new Error(`unknown method ${method}`);
    }
  }
  return server;
}
