/**
 * @noble/ed25519 v2 needs an explicit sync SHA-512 implementation.
 * Without it `ed.getPublicKey/sign/verify` throw "hashes.sha512Sync not set"
 * in the browser as well as in node — the wallet must set it once, before use.
 */
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { concatBytes } from "@noble/hashes/utils.js";

if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...messages: Uint8Array[]) => sha512(concatBytes(...messages));
}

export { ed };
