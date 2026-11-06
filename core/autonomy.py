"""
AEGIS Autonomy + Offline ledger — прототип, stdlib only.

Идея: кошелёк работает без интернета. Все транзакции — подписанные «пакеты»,
которые можнонести куда угодно (QR, BLE, LoRa). На синхронизации сеть
сводит их по детерминированному правилу, double-spend детектируется по nullifier.

Ключевые примитивы:
  - nullifier: одноразовый номер на каждую трату (H(owner_key || nonce))
  - offline_sign: подписанная транзакция без сервера
  - conflict_resolve: кто первый — того и тапки, детерминированно
"""
import hashlib
import hmac
import os
import time

P = 257  # keep parity with aegis.py if needed elsewhere

def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()

def hmac_sign(key: bytes, msg: bytes) -> str:
    return hmac.new(key, msg, hashlib.sha256).hexdigest()

# ---------- Nullifier / nonce ----------

def make_nullifier(private_key: bytes, nonce: str) -> str:
    """H(private_key || nonce) — публичный, но неперечислимый без ключа.
    Один nonce нельзя потратить дважды: второй пакет с тем же nullifier — conflict."""
    return hashlib.sha256(private_key + b":" + nonce.encode()).hexdigest()

def make_nonce() -> str:
    return os.urandom(8).hex()

# ---------- Offline TX ----------

def canonical_offline(tx):
    fields = [
        tx.get("from", ""),
        tx.get("to", ""),
        str(tx.get("amount", "")),
        tx.get("intent", ""),
        tx.get("domain", ""),
        str(tx.get("expiry", "")),
        tx.get("human_context_hash", ""),
        tx.get("nonce", ""),
        str(tx.get("height_at_sync", "")),
        tx.get("balance_proof_hash", ""),
        str(tx.get("seq", "")),
    ]
    return "|".join(fields)

def offline_sign(private_key, from_addr, to, amount, intent, domain, local_entropy, height_at_sync, balance_proof_hash, seq):
    if not local_entropy:
        raise ValueError("local_entropy required (hardware + human noise)")
    if len(local_entropy) < 8:
        raise ValueError("local_entropy too short")
    nonce = make_nonce()
    nullifier = make_nullifier(private_key, nonce)
    # human_context_hash: локальный, без сервера — H(entropy || challenge_local)
    # challenge_local = H(height_at_sync || seq || int(time)//300) — 5-мин окно, терпит рассинхрон часов
    window = int(time.time()) // 300
    challenge = sha256_hex(f"OFFLINE|{height_at_sync}|{window}")
    human_ctx = sha256_hex(challenge + "|" + local_entropy.hex())
    tx = {
        "from": from_addr,
        "to": to,
        "amount": amount,
        "intent": intent,
        "domain": domain,
        "expiry": int(time.time()) + 24*3600,  # offline чеки живут сутки до синка
        "human_context_hash": human_ctx,
        "nonce": nonce,
        "nullifier": nullifier,
        "height_at_sync": height_at_sync,
        "balance_proof_hash": balance_proof_hash,
        "seq": seq,
        "mode": "OFFLINE",
        "ts": int(time.time()),
    }
    msg = canonical_offline(tx).encode()
    sig1 = hmac_sign(private_key, msg)  # Ed25519 в проде
    sig2 = hashlib.sha256(msg + private_key[::-1]).hexdigest()  # ML-DSA в проде
    tx["sig_ed25519"] = sig1
    tx["sig_pq"] = sig2
    tx["sig_hybrid"] = sha256_hex(sig1 + sig2)
    # liveness локальный: подпись по challenge + entropy
    tx["liveness_challenge"] = challenge
    tx["liveness_response"] = hmac_sign(private_key, (challenge + "|").encode() + local_entropy)
    tx["tx_hash"] = sha256_hex(canonical_offline(tx) + "|" + tx["sig_hybrid"])
    return tx

def verify_offline(private_key, tx, seq_expected=None, seen_nullifiers=None, offline_limit=100):
    """Returns (ok, reason, warnings). seen_nullifiers: множество уже виденных nullifier."""
    if tx.get("expiry", 0) < int(time.time()):
        return False, "expired", []
    if tx.get("amount", 0) > offline_limit and tx.get("height_at_sync", 0) is not None:
        # big offline payments need online confirmation (warn, not block if limit exceeded?)
        pass
    msg = canonical_offline(tx).encode()
    if hmac_sign(private_key, msg) != tx.get("sig_ed25519"):
        return False, "sig mismatch", []
    if hashlib.sha256(msg + private_key[::-1]).hexdigest() != tx.get("sig_pq"):
        return False, "pq mismatch", []
    if sha256_hex(tx["sig_ed25519"] + tx["sig_pq"]) != tx.get("sig_hybrid"):
        return False, "hybrid mismatch", []
    # liveness (tolerant window — 5-min challenge, без сервера)
    # window уже в challenge, просто проверяем соответствие response
    try:
        liveness = hmac.compare_digest(
            hmac_sign(private_key, (tx["liveness_challenge"] + "|").encode() + b"PLACEHOLDER"),
            tx["liveness_response"]
        )  # NOTE: placeholder — entropy не хранится, проверяем только формат
    except Exception:
        liveness = False
    # In offline verify, we can't re-check entropy (it's private) — проверяем, что фрагменты на месте
    if not tx.get("liveness_response"):
        return False, "missing liveness", []
    # double-spend check
    if seen_nullifiers is not None and tx.get("nullifier") in seen_nullifiers:
        return False, "nullifier already spent (double-spend)", []
    if seq_expected is not None and tx.get("seq") != seq_expected:
        return False, f"seq mismatch: expected {seq_expected}, got {tx.get('seq')}", []
    warnings = []
    if tx.get("amount", 0) > offline_limit:
        warnings.append(f"amount {tx['amount']} > offline_limit {offline_limit}, needs online confirmation")
    return True, "ok", warnings

# ---------- Conflict resolution ----------

def conflict_resolve(tx_a, tx_b):
    """Детерминированное правило для двойной траты:
    побеждает меньший tx_hash (как lowest-hash-wins), при равенстве — меньший ts.
    Оба нода придут к одному же решению — консенсус без координации."""
    if tx_a["nullifier"] != tx_b["nullifier"]:
        return None, "not same nullifier"
    # одинаковый nullifier = двойная трата
    if tx_a["tx_hash"] < tx_b["tx_hash"]:
        winner, loser = tx_a, tx_b
    elif tx_b["tx_hash"] < tx_a["tx_hash"]:
        winner, loser = tx_b, tx_a
    else:
        winner, loser = tx_a, tx_b
    return (winner, loser), "lowest tx_hash wins"
