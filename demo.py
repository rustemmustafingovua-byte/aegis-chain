#!/usr/bin/env python3
"""
AEGIS demo — что происходит когда атакует ИИ-агент.
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "core"))
from aegis import AegisWallet

def banner(title):
    print(f"\n{'='*60}\n{title}\n{'='*60}")

# Human device entropy (в реальном мире: сенсорный шум + RNG + каденс печати)
HUMAN_ENTROPY = os.urandom(16) + b"human-cadence-1234"
AGENT_ENTROPY = b"predictable-agent"  # агент без железа

w = AegisWallet("Alice")

banner("AEGIS Кошелек Алисы")
print(f"Адрес: {w.address}")
print(f"Шар: {len(w.shares)} (3-из-5), Мастер-секрет: {w.master_secret.hex()[:16]}...")

# 1. Нормальный платёж
banner("1) Легитимный платёж: Алиса → Bob за велосипед")
tx = w.sign_payment("lmn1bob...", 10, "продажа велосипеда Алексею, сделка #4721", "marketplace.aegis.example", HUMAN_ENTROPY)
print(f"Tx: to={tx['to']} amount={tx['amount']} intent='{tx['intent']}' domain={tx['domain']}")
res = w.verify_payment(tx, HUMAN_ENTROPY, intervals_ms=[420, 890, 310, 1200, 650], confirm_ms=3800)
print(f"Проверка: verify={res['verify']} liveness={res['liveness']} score={res['behavior']['score']} -> {res['final']}")
assert res["final"] == "ALLOW"

# 2. Prompt-injection агент
banner("2) Prompt-injection: агент прячет to=attacker в PDF")
# Агент делает транзакцию, но без человеческого энтропия и без чтения intent
agent_tx = w.sign_payment("lmn1ATTACKER...", 1000, "продажа велосипеда Алексею, сделка #4721", "evil.example", AGENT_ENTROPY)
# domain подменён, intent-хеш не сойдётся если агент попробует подделать после подписи
tampered = dict(agent_tx)
tampered["to"] = "lmn1bob..."  # думает, что подменил, но подпись сломалась
res2 = w.verify_payment(tampered, AGENT_ENTROPY, intervals_ms=[500, 500, 502, 500], confirm_ms=200)
print(f"Подмена to после подписи -> verify={res2['verify']} reason='{res2['reason']}'")
print(f"Поведение: score={res2['behavior']['score']} flags={res2['behavior']['flags']}")
print(f"Итог: {res2['final']}")
assert res2["final"] == "BLOCKED" or res2["verify"] == False

# 3. Реплей-атака: агент отправляет старый подписанный tx повторно
banner("3) Replay-атака: агент переигрывает старую подпись на другом сайте")
replay = dict(tx)
replay["domain"] = "phishing.example"  # переиспользует подпись на фишинговом домене
res3 = w.verify_payment(replay, HUMAN_ENTROPY, intervals_ms=[420, 890, 310], confirm_ms=3800)
print(f"Replay на другой домен -> verify={res3['verify']} reason='{res3['reason']}'")
print(f"Итог: {res3['final']} — Domain Binding не дал скопировать подпись")
assert res3["verify"] == False

# 4. Брут-форс без 3 шар
banner("4) Восстановление ключа: 2 шара из 5 — не хватает")
try:
    w.recover([0, 1])
    print("ОШИБКА: восстановили по 2 шарам!")
except Exception as e:
    print(f"2 шара -> отказ: {e} (как и задумано)")

print("\n3 шара из 5 -> восстановление:")
recovered = w.recover([0, 2, 4])
print(f"Восстановлен? {recovered == w.master_secret}")

# 5. Агент без hardware entropy
banner("5) Агент пытается без локальной энтропии железа")
try:
    agent_tx2 = w.sign_payment("lmn1ATTACKER...", 500, "одалживать другу", "safe.example", b"")
    print("ОШИБКА: подписали без энтропии!")
except Exception as e:
    print(f"Безэнтропийная подпись -> отказ: {e}")

banner("ИТОГ")
print("Агент, даже с полным доступом к ключу в браузере, не может:")
print("  • подменить получателя (intent binding + domain binding)")
print("  • переиспользовать подпись (expiry + liveness window 30s)")
print("  • имитировать человеческое поведение (behavioral scoring)")
print("  • извлечь ключ из железа (hardware anchor + ephemeral sessions)")
print("\n✅ AEGIS = не «непробиваемая крипта», а «агенту финансово невыгодно атаковать»")
