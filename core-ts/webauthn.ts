/**
 * AEGIS WebAuthn / Passkey server-side verification (v1.12)
 *
 * The mobile wallet claims "Passkey = hardware anchor". That claim is only real
 * if the *server* verifies the WebAuthn ceremony. This module does exactly that:
 *
 *  - registration: parse attestationObject (CBOR) → authData → attested credential
 *    data → COSE public key. Check clientDataJSON type/challenge/origin, rpIdHash,
 *    UP flag and that credentialId matches the attestation.
 *  - assertion: verify the signature over authenticatorData || sha256(clientDataJSON)
 *    with the stored COSE key (ES256 / EdDSA), check origin/challenge/rpId, UP flag
 *    and the signature counter (monotonic; 0 = authenticator does not count).
 *
 * Attestation statements are intentionally NOT validated (fmt "none" is the norm
 * for platform passkeys and attests nothing about the device vendor). What we do
 * validate is what matters for a wallet: possession of the private key + freshness.
 *
 * No external dependencies: ~200 lines of CBOR + node:crypto.
 */
import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

/** Minimal public JWK shape we store for passkeys (EC P-256 or OKP Ed25519). */
export type PublicJwk = { kty: string; crv?: string; x: string; y?: string; ext?: boolean; [k: string]: unknown };

// ---------- base64url ----------
export function b64urlEncode(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}
export function b64urlDecode(s: string): Buffer {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new Error("bad base64url");
  return Buffer.from(s, "base64url");
}
export function challengeFromHex(hex: string): string {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("challenge must be 32-byte hex");
  return b64urlEncode(Buffer.from(hex, "hex"));
}
export function challengeToHex(b64: string): string {
  return b64urlDecode(b64).toString("hex");
}

// ---------- minimal CBOR (RFC 8949) ----------
type CborValue = number | bigint | Buffer | string | CborValue[] | { [k: string]: CborValue } | boolean | null;

export function cborDecode(buf: Buffer): { value: CborValue; rest: Buffer } {
  let off = 0;
  function readLen(ai: number): number {
    if (ai < 24) return ai;
    if (ai === 24) { const v = buf.readUInt8(off); off += 1; return v; }
    if (ai === 25) { const v = buf.readUInt16BE(off); off += 2; return v; }
    if (ai === 26) { const v = buf.readUInt32BE(off); off += 4; return v; }
    if (ai === 27) { const hi = buf.readUInt32BE(off); const lo = buf.readUInt32BE(off + 4); off += 8; return hi * 2 ** 32 + lo; }
    throw new Error(`cbor: unsupported additional info ${ai}`);
  }
  function item(): CborValue {
    if (off >= buf.length) throw new Error("cbor: eof");
    const ib = buf.readUInt8(off); off += 1;
    const major = ib >> 5;
    const ai = ib & 0x1f;
    switch (major) {
      case 0: return readLen(ai);
      case 1: return -1 - readLen(ai);
      case 2: { const n = readLen(ai); const v = buf.subarray(off, off + n); off += n; return Buffer.from(v); }
      case 3: { const n = readLen(ai); const v = buf.subarray(off, off + n); off += n; return v.toString("utf8"); }
      case 4: { const n = readLen(ai); const arr: CborValue[] = []; for (let i = 0; i < n; i++) arr.push(item()); return arr; }
      case 5: {
        const n = readLen(ai); const map: { [k: string]: CborValue } = {};
        for (let i = 0; i < n; i++) { const k = item(); const v = item(); map[String(k)] = v; }
        return map;
      }
      case 6: readLen(ai); return item(); // tag: ignore
      case 7:
        if (ai === 20) return false;
        if (ai === 21) return true;
        if (ai === 22) return null;
        if (ai === 23) return 0; // undefined → 0
        if (ai === 26) { const v = buf.readFloatBE(off); off += 4; return v; }
        if (ai === 27) { const v = buf.readDoubleBE(off); off += 8; return v; }
        return 0;
      default: throw new Error(`cbor: major ${major}`);
    }
  }
  const value = item();
  return { value, rest: buf.subarray(off) };
}

export function cborEncode(value: CborValue): Buffer {
  function head(major: number, len: number): Buffer {
    if (len < 24) return Buffer.from([(major << 5) | len]);
    if (len < 256) return Buffer.from([(major << 5) | 24, len]);
    if (len < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(len, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(len, 1); return b;
  }
  if (value === null) return Buffer.from([0xf6]);
  if (value === true) return Buffer.from([0xf5]);
  if (value === false) return Buffer.from([0xf4]);
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("cbor: only integers/floats-as-int supported");
    if (value >= 0) return Buffer.concat([head(0, value)]);
    return Buffer.concat([head(1, -1 - value)]);
  }
  if (typeof value === "bigint") return cborEncode(value >= 0n ? Number(value) : Number(value));
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === "string") { const b = Buffer.from(value, "utf8"); return Buffer.concat([head(3, b.length), b]); }
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cborEncode)]);
  const entries = Object.entries(value);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cborEncode(k), cborEncode(v)])]);
}

// ---------- COSE key ----------
export type CoseKey = { kty: number; alg: number; crv?: number; x: Buffer; y?: Buffer };

export function parseCoseKey(map: { [k: string]: CborValue }): CoseKey {
  const kty = Number(map["1"]);
  const alg = Number(map["3"]);
  const crv = map["-1"] !== undefined ? Number(map["-1"]) : undefined;
  const x = map["-2"];
  const y = map["-3"];
  if (!Buffer.isBuffer(x)) throw new Error("cose: missing x");
  if (y !== undefined && !Buffer.isBuffer(y)) throw new Error("cose: bad y");
  return { kty, alg, crv, x, y: y as Buffer | undefined };
}

const COSE_EC2 = 2;
const COSE_OKP = 1;
const CRV_P256 = 1;
const CRV_ED25519 = 6;
const ALG_ES256 = -7;
const ALG_EDDSA = -8;

export function coseToPublicKey(k: CoseKey): KeyObject {
  if (k.kty === COSE_EC2 && k.crv === CRV_P256 && k.y) {
    return createPublicKey({
      key: { kty: "EC", crv: "P-256", x: b64urlEncode(k.x), y: b64urlEncode(k.y) } as unknown as import("node:crypto").JsonWebKey,
      format: "jwk",
    });
  }
  if (k.kty === COSE_OKP && k.crv === CRV_ED25519) {
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64urlEncode(k.x) } as unknown as import("node:crypto").JsonWebKey, format: "jwk" });
  }
  throw new Error(`cose: unsupported kty=${k.kty} crv=${k.crv}`);
}

export function coseToJwk(k: CoseKey): PublicJwk {
  coseToPublicKey(k); // validates
  if (k.kty === COSE_EC2) return { kty: "EC", crv: "P-256", x: b64urlEncode(k.x), y: b64urlEncode(k.y!), ext: true };
  return { kty: "OKP", crv: "Ed25519", x: b64urlEncode(k.x), ext: true };
}

// ---------- client data ----------
export type ClientData = { type: string; challenge: string; origin: string; crossOrigin?: boolean };

export function parseClientData(b64: string): ClientData {
  let json: any;
  try { json = JSON.parse(b64urlDecode(b64).toString("utf8")); } catch { throw new Error("clientDataJSON: not JSON"); }
  if (typeof json.type !== "string" || typeof json.challenge !== "string" || typeof json.origin !== "string") {
    throw new Error("clientDataJSON: missing type/challenge/origin");
  }
  return json as ClientData;
}

function normOrigin(o: string) { return o.replace(/\/+$/, "").toLowerCase(); }

export function checkClientData(cd: ClientData, expectedType: "webauthn.create" | "webauthn.get", expectedChallenge: string, expectedOrigin: string | string[]) {
  if (cd.type !== expectedType) throw new Error(`clientData: type ${cd.type} != ${expectedType}`);
  if (challengeToHex(cd.challenge) !== challengeToHex(expectedChallenge)) throw new Error("clientData: challenge mismatch");
  const allowed = (Array.isArray(expectedOrigin) ? expectedOrigin : [expectedOrigin]).map(normOrigin);
  if (!allowed.includes(normOrigin(cd.origin))) throw new Error(`clientData: origin ${cd.origin} not allowed`);
  if (cd.crossOrigin === true) throw new Error("clientData: crossOrigin not allowed");
}

// ---------- authenticator data ----------
export const FLAG_UP = 0x01; // user present
export const FLAG_UV = 0x04; // user verified
export const FLAG_AT = 0x40; // attested credential data included
export const FLAG_ED = 0x80; // extension data included

export type AuthData = {
  rpIdHash: Buffer;
  flags: number;
  counter: number;
  aaguid?: Buffer;
  credentialId?: Buffer;
  cose?: CoseKey;
  raw: Buffer;
};

export function parseAuthenticatorData(buf: Buffer, requireAttested = false): AuthData {
  if (buf.length < 37) throw new Error("authData: too short");
  const rpIdHash = buf.subarray(0, 32);
  const flags = buf.readUInt8(32);
  const counter = buf.readUInt32BE(33);
  const out: AuthData = { rpIdHash, flags, counter, raw: buf };
  if (flags & FLAG_AT) {
    if (buf.length < 55) throw new Error("authData: attested data truncated");
    const aaguid = buf.subarray(37, 53);
    const credLen = buf.readUInt16BE(53);
    const credEnd = 55 + credLen;
    if (buf.length <= credEnd) throw new Error("authData: credential id truncated");
    const credentialId = buf.subarray(55, credEnd);
    const { value } = cborDecode(buf.subarray(credEnd));
    if (typeof value !== "object" || value === null || Array.isArray(value) || Buffer.isBuffer(value)) throw new Error("authData: bad COSE key");
    out.aaguid = aaguid;
    out.credentialId = credentialId;
    out.cose = parseCoseKey(value as { [k: string]: CborValue });
  } else if (requireAttested) {
    throw new Error("authData: missing attested credential data (AT flag)");
  }
  return out;
}

// ---------- registration ----------
export type RegistrationInput = {
  clientDataJSON: string; // b64url
  attestationObject: string; // b64url
  expectedChallenge: string; // b64url (from challengeFromHex)
  expectedOrigin: string | string[];
  expectedRpId: string;
  requireUserVerification?: boolean;
};
export type VerifiedRegistration = {
  credentialId: string; // b64url
  publicKeyJwk: PublicJwk;
  alg: number;
  counter: number;
  rpId: string;
  origin: string;
};

export function verifyRegistration(input: RegistrationInput): VerifiedRegistration {
  const cd = parseClientData(input.clientDataJSON);
  checkClientData(cd, "webauthn.create", input.expectedChallenge, input.expectedOrigin);
  const att = cborDecode(b64urlDecode(input.attestationObject)).value;
  if (typeof att !== "object" || att === null || Array.isArray(att) || Buffer.isBuffer(att)) throw new Error("attestationObject: not a map");
  const map = att as { [k: string]: CborValue };
  if (typeof map.fmt !== "string") throw new Error("attestationObject: missing fmt");
  if (!Buffer.isBuffer(map.authData)) throw new Error("attestationObject: missing authData");
  const auth = parseAuthenticatorData(map.authData, true);
  const rpIdHash = createHash("sha256").update(input.expectedRpId).digest();
  if (!auth.rpIdHash.equals(rpIdHash)) throw new Error("authData: rpIdHash mismatch");
  if (!(auth.flags & FLAG_UP)) throw new Error("authData: user not present");
  if (input.requireUserVerification && !(auth.flags & FLAG_UV)) throw new Error("authData: user not verified");
  if (!auth.credentialId || !auth.cose) throw new Error("authData: no credential");
  return {
    credentialId: b64urlEncode(auth.credentialId),
    publicKeyJwk: coseToJwk(auth.cose),
    alg: auth.cose.alg,
    counter: auth.counter,
    rpId: input.expectedRpId,
    origin: cd.origin,
  };
}

// ---------- assertion ----------
export type AssertionInput = {
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  expectedChallenge: string;
  expectedOrigin: string | string[];
  expectedRpId: string;
  publicKeyJwk: PublicJwk;
  storedCounter: number;
  requireUserVerification?: boolean;
};
export type VerifiedAssertion = { ok: true; newCounter: number; reason?: undefined } | { ok: false; reason: string };

export function verifyAssertion(input: AssertionInput): VerifiedAssertion {
  try {
    const cd = parseClientData(input.clientDataJSON);
    checkClientData(cd, "webauthn.get", input.expectedChallenge, input.expectedOrigin);
    const authBytes = b64urlDecode(input.authenticatorData);
    const auth = parseAuthenticatorData(authBytes, false);
    const rpIdHash = createHash("sha256").update(input.expectedRpId).digest();
    if (!auth.rpIdHash.equals(rpIdHash)) return { ok: false, reason: "rpIdHash mismatch" };
    if (!(auth.flags & FLAG_UP)) return { ok: false, reason: "user not present" };
    if (input.requireUserVerification && !(auth.flags & FLAG_UV)) return { ok: false, reason: "user not verified" };
    if (auth.counter !== 0 && auth.counter <= input.storedCounter) return { ok: false, reason: `counter replay (${auth.counter} <= ${input.storedCounter})` };
    const clientDataHash = createHash("sha256").update(b64urlDecode(input.clientDataJSON)).digest();
    const signedData = Buffer.concat([authBytes, clientDataHash]);
    const key = createPublicKey({ key: input.publicKeyJwk as unknown as import("node:crypto").JsonWebKey, format: "jwk" });
    const sig = b64urlDecode(input.signature);
    const alg = input.publicKeyJwk.kty === "OKP" ? null : "sha256";
    const ok = alg === null ? cryptoVerify(null, signedData, key, sig) : cryptoVerify(alg, signedData, key, sig);
    if (!ok) return { ok: false, reason: "signature invalid" };
    return { ok: true, newCounter: auth.counter };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? "assertion failed" };
  }
}

// ---------- policy defaults ----------
export function defaultOrigins(): string[] {
  const env = process.env.AEGIS_ORIGIN;
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
  return ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173", "http://localhost:8899", "http://127.0.0.1:8899"];
}
export function defaultRpId(): string {
  return process.env.AEGIS_RP_ID ?? "localhost";
}

// ---------- registry ----------
export type PasskeyBinding = {
  address: string;
  credentialId: string;
  publicKeyJwk: PublicJwk;
  alg: number;
  counter: number;
  createdAt: number;
  lastUsedAt?: number;
  label?: string;
};

export class PasskeyRegistry {
  byCredential = new Map<string, PasskeyBinding>();
  byAddress = new Map<string, Set<string>>();

  bind(b: PasskeyBinding): void {
    if (!b.address.startsWith("aeg1")) throw new Error("bad address");
    this.byCredential.set(b.credentialId, b);
    let set = this.byAddress.get(b.address);
    if (!set) { set = new Set(); this.byAddress.set(b.address, set); }
    set.add(b.credentialId);
  }
  get(credentialId: string): PasskeyBinding | undefined { return this.byCredential.get(credentialId); }
  forAddress(address: string): PasskeyBinding[] {
    const set = this.byAddress.get(address);
    return set ? [...set].map((id) => this.byCredential.get(id)!).filter(Boolean) : [];
  }
  has(address: string): boolean { return (this.byAddress.get(address)?.size ?? 0) > 0; }
  touch(credentialId: string, counter: number): void {
    const b = this.byCredential.get(credentialId);
    if (!b) return;
    if (counter > b.counter) b.counter = counter;
    b.lastUsedAt = Date.now();
  }
  unbind(credentialId: string): boolean {
    const b = this.byCredential.get(credentialId);
    if (!b) return false;
    this.byCredential.delete(credentialId);
    this.byAddress.get(b.address)?.delete(credentialId);
    return true;
  }
  toJSON() {
    return { bindings: [...this.byCredential.values()] };
  }
  static fromJSON(j: any): PasskeyRegistry {
    const r = new PasskeyRegistry();
    for (const b of j?.bindings ?? []) {
      try { r.bind(b); } catch { /* skip malformed */ }
    }
    return r;
  }
}
