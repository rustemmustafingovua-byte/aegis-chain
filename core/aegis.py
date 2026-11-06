"""
AEGIS core — prototype, stdlib only.

Components:
  - Shamir Secret Sharing (mod 257)
  - Intent-bound transactions + hybrid-like signature (HMAC modeled as sign)
  - Proof-of-Liveness challenge/response
  - Behavioral scoring (agent detection)
  - Threshold recovery + ephemeral session keys
"""
import hashlib
import hmac
import os
import time

# ---------- utils ----------

def sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()

def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()

def hmac_sign(key: bytes, msg: bytes) -> str:
    return hmac.new(key, msg, hashlib.sha256).hexdigest()

# ---------- Shamir over GF-like field mod 257 ----------

P = 257  # prime, elements 0..256, 256 represents byte 256? We map secret bytes -> 1..256

def _eval_poly(coeffs, x):
    res = 0
    # coeffs[0] = secret, coeffs[1]*x + coeffs[2]*x^2 + ...
    pow_x = 1
    for c in coeffs:
        res = (res + c * pow_x) % P
        pow_x = (pow_x * x) % P
    return res

def _lagrange_interpolate(shares, x):
    # shares: list of (x_i, y_i), interpolate at x
    result = 0
    for i, (x_i, y_i) in enumerate(shares):
        num = 1
        den = 1
        for j, (x_j, _) in enumerate(shares):
            if i == j:
                continue
            num = num * (x - x_j) % P
            den = den * (x_i - x_j) % P
        # den inverse mod P
        den_inv = pow(den, P - 2, P)
        result = (result + y_i * num % P * den_inv) % P
    return result

def shamir_split(secret: bytes, n: int = 5, k: int = 3) -> list:
    """Split secret (bytes) into n shares, any k recover. Returns list of (x, bytes_share)."""
    shares = []
    # We split byte-by-byte
    for byte in secret:
        secret_val = byte + 1  # 1..256 -> avoid 0 mapping issue, we store +1
        coeffs = [secret_val] + [os.urandom(1)[0] % P + 1 for _ in range(k - 1)]  # 1..256? mod 257
        # Actually coefficient can be 0..P-1, use any
        coeffs = [secret_val] + [int.from_bytes(os.urandom(1), 'big') % P for _ in range(k - 1)]
        for x in range(1, n + 1):
            y = _eval_poly(coeffs, x)
            shares.append((x, y))

    # Pack per-share: for each x, collect its y's across bytes
    packed = []
    for x in range(1, n + 1):
        ys = [shares[i][1] for i in range(len(shares)) if shares[i][0] == x]
        packed.append((x, bytes([y % 256 for y in ys]), [y for y in ys]))
    return packed

def shamir_recover(packed_shares, k: int = 3, secret_len: int = None) -> bytes:
    """packed_shares: list of (x, bytes_array, ys_list) from split. Any k."""
    if len(packed_shares) < k:
        raise ValueError("Need at least k shares")
    # Unpack ys
    # Determine secret len
    if secret_len is None:
        secret_len = len(packed_shares[0][2])
    # For each byte position, interpolate at 0
    recovered = []
    for pos in range(secret_len):
        pts = [(x, ys[pos]) for (x, _, ys) in packed_shares[:k]]
        secret_val = _lagrange_interpolate(pts, 0)
        recovered.append((secret_val - 1) % 256)
    return bytes(recovered)

# ---------- Intent-bound Tx ----------

def canonical_tx(tx: dict) -> str:
    """Stable canonical representation of intent-bound transaction."""
    fields = [
        tx.get("to", ""),
        str(tx.get("amount", "")),
        tx.get("intent", ""),
        tx.get("domain", ""),
        str(tx.get("expiry", "")),
        tx.get("human_context_hash", ""),
        str(tx.get("nonce", "")),
    ]
    return "|".join(fields)

def sign_tx(private_key: bytes, tx: dict) -> dict:
    """Sign canonical tx with hybrid-like signature: HMAC + hash chaining.
    In production: Ed25519 + ML-DSA. Here we model as HMAC(key, canonical) + H(prev||entropy).
    """
    msg = canonical_tx(tx).encode()
    sig_ed = hmac_sign(private_key, msg)  # stands in for Ed25519
    # PQ-like second signature: hash of msg + key fragment (modeled Lattice)
    pq_sig = hashlib.sha256(msg + private_key[::-1]).hexdigest()
    # Liveness binding: include human_context_hash already in msg, plus freshness
    # Return signed tx copy
    out = dict(tx)
    out["sig_ed25519"] = sig_ed
    out["sig_pq"] = pq_sig
    out["sig_hybrid"] = sha256_hex(sig_ed + pq_sig)
    return out

def verify_tx(public_key: bytes, signed_tx: dict) -> tuple:
    """Returns (ok, reason)."""
    # Check expiry
    if signed_tx.get("expiry", 0) < int(time.time()):
        return False, "expired"
    msg = canonical_tx(signed_tx).encode()
    expected_ed = hmac_sign(public_key, msg)
    expected_pq = hashlib.sha256(msg + public_key[::-1]).hexdigest()
    if expected_ed != signed_tx.get("sig_ed25519"):
        return False, "sig_ed25519 mismatch (tampered intent/to/amount/domain?)"
    if expected_pq != signed_tx.get("sig_pq"):
        return False, "sig_pq mismatch (quantum/hybrid check failed)"
    if sha256_hex(expected_ed + expected_pq) != signed_tx.get("sig_hybrid"):
        return False, "hybrid binding mismatch"
    return True, "ok"

# ---------- Liveness ----------

def liveness_challenge(last_block_hash: str, window_seconds: int = 30) -> dict:
    now = int(time.time())
    window = now // window_seconds
    challenge = sha256_hex(f"{last_block_hash}|{window}")
    return {"challenge": challenge, "window": window, "expires_in": window_seconds}

def liveness_response(private_key: bytes, challenge: dict, local_entropy: bytes) -> str:
    """local_entropy = sensor noise + secure RNG + typing cadence hash (hardware)."""
    if not local_entropy:
        raise ValueError("local_entropy required (hardware + human noise)")
    msg = (challenge["challenge"] + "|").encode() + local_entropy
    return hmac_sign(private_key, msg)

def verify_liveness(public_key: bytes, challenge: dict, local_entropy: bytes, response: str, window_seconds: int = 30) -> bool:
    now_window = int(time.time()) // window_seconds
    if challenge["window"] != now_window and challenge["window"] != now_window - 1:
        return False  # stale
    expected = hmac_sign(public_key, (challenge["challenge"] + "|").encode() + local_entropy)
    return hmac.compare_digest(expected, response)

# ---------- Behavioral scoring ----------

def behavioral_score(intervals_ms: list, human_context_hash: str, confirm_ms: int) -> dict:
    """Score 0-100: 100 = clearly human, <40 = bot-like.
    intervals_ms: inter-action intervals (ml), confirm_ms: time to confirm after seeing amount.
    """
    if not intervals_ms:
        return {"score": 0, "flags": ["no intervals"], "verdict": "blocked"}
    # entropy of intervals
    import math
    # mean variance
    mean = sum(intervals_ms) / len(intervals_ms) if intervals_ms else 0
    var = sum((x - mean) ** 2 for x in intervals_ms) / len(intervals_ms) if intervals_ms else 0
    std = math.sqrt(var)
    flags = []
    score = 50  # base
    # High variance = human
    if std > 300:
        score += 25
        flags.append("high variance (human-like)")
    elif std > 100:
        score += 15
        flags.append("moderate variance")
    elif std < 20:
        score -= 30
        flags.append("ultra-regular intervals (bot-like)")
    # Too fast confirm
    if confirm_ms < 800:
        score -= 30
        flags.append("confirm too fast (<800ms) (agent-like)")
    elif confirm_ms < 1500:
        score -= 10
        flags.append("fast confirm")
    elif confirm_ms > 3000:
        score += 15
        flags.append("thoughtful confirm")
    # Hash entropy check: too regular hash pattern (e.g., same prefix) is suspicious
    if len(set(human_context_hash)) < 4:
        score -= 10
        flags.append("low-entropy human_context_hash")
    # Clamp
    score = max(0, min(100, score))
    verdict = "allow"
    if score < 40:
        verdict = "blocked"
    elif score < 70:
        verdict = "review"
    return {"score": score, "flags": flags, "mean": round(mean, 1), "std": round(std, 1), "verdict": verdict}

# ---------- Threshold session ----------

def ephemeral_session_key(master_secret: bytes, session_id: str, expires_in: int = 60) -> dict:
    now = int(time.time())
    seed = sha256(master_secret + b":" + session_id.encode() + str(now).encode())
    session_key = hashlib.sha256(seed).digest()
    return {"key": session_key.hex(), "session_id": session_id, "iat": now, "exp": now + expires_in, "max_amount": 100}

def verify_session(session: dict) -> bool:
    now = int(time.time())
    return now <= session["exp"]

# ---------- Wallet ----------

class AegisWallet:
    def __init__(self, name: str):
        self.name = name
        # master secret (in production: inside secure enclave)
        self.master_secret = os.urandom(32)
        self.private_key = hashlib.sha256(b"AEGIS-KEY:" + self.master_secret).digest()
        self.public_key = hashlib.sha256(b"AEGIS-PUB:" + self.private_key).digest()
        self.address = f"lmn1{hashlib.sha256(self.public_key).hexdigest()[:40]}"
        self.last_block_hash = sha256_hex("genesis")[:16]
        # Split master for backup
        self.shares = shamir_split(self.master_secret, n=5, k=3)

    def recover(self, share_indices: list) -> bytes:
        """Recover master_secret from any 3 shares (by index)."""
        chosen = [self.shares[i] for i in share_indices]
        # Convert packed format to what shamir_recover expects: (x, bytes, ys)
        packed = [(x, b, list(y)) for (x, b, y) in chosen]
        recovered = shamir_recover(packed, k=3, secret_len=len(self.master_secret))
        assert recovered == self.master_secret, "Recovery failed!"
        return recovered

    def sign_payment(self, to: str, amount: int, intent: str, domain: str, local_entropy: bytes) -> dict:
        # liveness challenge
        ch = liveness_challenge(self.last_block_hash)
        # we simulate human entropy
        human_ctx = sha256_hex(ch["challenge"] + local_entropy.hex())
        tx = {
            "to": to,
            "amount": amount,
            "intent": intent,
            "domain": domain,
            "expiry": int(time.time()) + 120,
            "human_context_hash": human_ctx,
            "nonce": os.urandom(8).hex(),
            "from": self.address,
        }
        signed = sign_tx(self.private_key, tx)
        signed["liveness_challenge"] = ch
        signed["liveness_response"] = liveness_response(self.private_key, ch, local_entropy)
        return signed

    def verify_payment(self, signed_tx: dict, local_entropy: bytes, intervals_ms: list, confirm_ms: int) -> dict:
        ok, reason = verify_tx(self.private_key, signed_tx)
        # liveness check
        liv_ok = False
        try:
            liv_ok = verify_liveness(self.private_key, signed_tx["liveness_challenge"], local_entropy, signed_tx["liveness_response"])
        except Exception:
            liv_ok = False
        behav = behavioral_score(intervals_ms, signed_tx.get("human_context_hash", ""), confirm_ms)
        # final verdict
        if not ok:
            final = "BLOCKED"
        elif not liv_ok:
            final = "BLOCKED (no fresh human liveness)"
        elif behav["verdict"] == "blocked":
            final = "BLOCKED (agent-like behavior)"
        elif behav["verdict"] == "review":
            final = "REVIEW (guardian approval needed)"
        else:
            final = "ALLOW"
        return {"verify": ok, "reason": reason, "liveness": liv_ok, "behavior": behav, "final": final}
