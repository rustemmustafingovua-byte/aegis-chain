/**
 * AEGIS Shamir backup (browser) — Shamir 3-of-5 mod 257, port of core-ts/shamir.ts
 * Shares encode edPrivate (32 bytes). Store 2 shares paper, 1 HSM, 1 trusted, 1 phone.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
const P = 257;
function evalPoly(coeffs: number[], x: number): number {
  let res = 0; let powX = 1;
  for (const c of coeffs) { res = (res + c * powX) % P; powX = (powX * x) % P; }
  return res;
}
function modPow(a: number, e: number): number {
  let r = 1; let base = a;
  while (e) { if (e & 1) r = (r * base) % P; base = (base * base) % P; e >>= 1; }
  return r;
}
function lagrange(shares: [number, number][], x: number): number {
  let result = 0;
  for (let i = 0; i < shares.length; i++) {
    const [xi, yi] = shares[i];
    let num = 1; let den = 1;
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
export type Share = { x: number; y: string };
export function splitSecret(secret: Uint8Array, n = 5, k = 3): Share[] {
  const secretBytes = Array.from(secret);
  const perX: number[][] = Array.from({ length: n }, () => []);
  for (const byte of secretBytes) {
    const coeffs: number[] = [byte];
    for (let i = 1; i < k; i++) coeffs.push(crypto.getRandomValues(new Uint8Array(1))[0] % 256);
    for (let x = 1; x <= n; x++) perX[x - 1].push(evalPoly(coeffs, x));
  }
  return perX.map((ys, i) => ({ x: i + 1, y: bytesToHex(new Uint8Array(ys)) }));
}
export function recoverSecret(shares: Share[], len = 32): Uint8Array {
  const out = new Uint8Array(len);
  const xs = shares.map(s => s.x);
  for (let pos = 0; pos < len; pos++) {
    const pairs: [number, number][] = shares.map(s => [s.x, hexToBytes(s.y)[pos]]);
    out[pos] = lagrange(pairs, 0);
  }
  return out;
}
export function backupJson(shares: Share[]): string {
  return JSON.stringify({ v: "aegis-shamir-3/5", shares }, null, 2);
}
export function parseBackup(json: string): Share[] {
  const j = JSON.parse(json);
  if (j.v !== "aegis-shamir-3/5" || !Array.isArray(j.shares)) throw new Error("bad backup");
  return j.shares as Share[];
}
export function secretFingerprint(secret: Uint8Array): string {
  return bytesToHex(sha256(secret)).slice(0, 16);
}
