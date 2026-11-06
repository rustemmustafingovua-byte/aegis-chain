/**
 * Shamir Secret Sharing mod 257 — port from python prototype
 * Split secret bytes into n shares, any k recover.
 */
import { randomBytes } from "node:crypto";

const P = 257;

function evalPoly(coeffs: number[], x: number): number {
  let res = 0;
  let powX = 1;
  for (const c of coeffs) {
    res = (res + c * powX) % P;
    powX = (powX * x) % P;
  }
  return res;
}
function modPow(a: number, e: number): number {
  let r = 1;
  let base = a;
  while (e) {
    if (e & 1) r = (r * base) % P;
    base = (base * base) % P;
    e >>= 1;
  }
  return r;
}
function lagrange(shares: [number, number][], x: number): number {
  let result = 0;
  for (let i = 0; i < shares.length; i++) {
    const [xi, yi] = shares[i];
    let num = 1;
    let den = 1;
    for (let j = 0; j < shares.length; j++) {
      if (i === j) continue;
      const [xj] = shares[j];
      num = (num * (x - xj)) % P;
      den = (den * (xi - xj)) % P;
    }
    const denInv = modPow(((den % P) + P) % P, P - 2);
    result = (result + (yi * num % P) * denInv) % P;
  }
  return result;
}

export type ShamirShare = { x: number; y: number[] }; // y per byte position

export function shamirSplit(secret: Buffer, n = 5, k = 3): ShamirShare[] {
  const perX: number[][] = Array.from({ length: n }, () => []);
  for (const byte of secret) {
    const secretVal = byte + 1;
    const coeffs = [secretVal];
    for (let i = 1; i < k; i++) {
      coeffs.push(randomBytes(1)[0] % P);
    }
    for (let x = 1; x <= n; x++) {
      perX[x - 1].push(evalPoly(coeffs, x));
    }
  }
  return perX.map((y, i) => ({ x: i + 1, y }));
}

export function shamirRecover(shares: ShamirShare[], k = 3, secretLen?: number): Buffer {
  if (shares.length < k) throw new Error("Need at least k shares");
  const len = secretLen ?? shares[0].y.length;
  const out: number[] = [];
  for (let pos = 0; pos < len; pos++) {
    const pts: [number, number][] = shares.slice(0, k).map((s) => [s.x, s.y[pos]]);
    const v = lagrange(pts, 0);
    out.push(((v - 1) % 256 + 256) % 256);
  }
  return Buffer.from(out);
}
