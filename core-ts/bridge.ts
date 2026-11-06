/**
 * AEGIS Bridge — Base <-> AEGIS Chain (HTLC swaps, как roadmap v0.3 Lumen)
 * Прямой своп любой монеты → AEGIS без биржи.
 * HTLC: secret = random, hashlock = sha256(secret). Counterparty раскрывает secret на Base.
 */
import { createHash, randomBytes } from "node:crypto";

export type Htlc = { id: string; from: string; to: string; amount: bigint; hashlock: string; timelock: number; secret?: string; state: "funded" | "claimed" | "refunded" };
export class Bridge {
  htlcs = new Map<string, Htlc>();
  fund(id: string, from: string, to: string, amount: bigint, timelockSec = 3600) {
    const secret = randomBytes(32);
    const hashlock = createHash("sha256").update(secret).digest("hex");
    const htlc: Htlc = { id, from, to, amount, hashlock, timelock: Date.now() / 1000 + timelockSec, secret: secret.toString("hex"), state: "funded" };
    this.htlcs.set(id, htlc);
    return htlc;
  }
  claim(id: string, secretHex: string) {
    const h = this.htlcs.get(id);
    if (!h || h.state !== "funded") throw new Error("not funded");
    const check = createHash("sha256").update(Buffer.from(secretHex, "hex")).digest("hex");
    if (check !== h.hashlock) throw new Error("bad secret");
    h.state = "claimed"; h.secret = secretHex;
    return h;
  }
  refund(id: string) {
    const h = this.htlcs.get(id);
    if (!h || h.state !== "funded") throw new Error("not funded");
    if (Date.now() / 1000 < h.timelock) throw new Error("timelock not expired");
    h.state = "refunded";
    return h;
  }
  // Коэффициент Base→AEGIS: курс через AMM quote (см. ledger.swap)
  quoteBaseToAegis(usdcIn: bigint, ammBase: bigint, ammQuote: bigint): bigint {
    const fee = (usdcIn * 30n) / 10_000n;
    const eff = usdcIn - fee;
    return (ammBase * eff) / (ammQuote + eff);
  }
}
