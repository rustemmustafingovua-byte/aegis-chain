import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "core"))
from aegis import AegisWallet

def test_legit_payment():
    w = AegisWallet("Alice")
    ent = os.urandom(16) + b"human"
    tx = w.sign_payment("lmn1bob", 10, "test payment", "market.example", ent)
    r = w.verify_payment(tx, ent, [400,800,600], 4000)
    assert r["final"] == "ALLOW"

def test_tamper_blocked():
    w = AegisWallet("Alice")
    ent = os.urandom(16) + b"human"
    tx = w.sign_payment("lmn1bob", 10, "test", "a.example", ent)
    tx["to"] = "lmn1ATTACKER"
    r = w.verify_payment(tx, ent, [400,800], 3000)
    assert r["verify"] == False

def test_replay_blocked():
    w = AegisWallet("Alice")
    ent = os.urandom(16) + b"human"
    tx = w.sign_payment("lmn1bob", 10, "test", "a.example", ent)
    tx["domain"] = "phishing.example"
    r = w.verify_payment(tx, ent, [400,800], 3000)
    assert r["verify"] == False

def test_shamir_3of5():
    w = AegisWallet("Bob")
    rec = w.recover([0,1,3])
    assert rec == w.master_secret

def test_shamir_2of5_fails():
    w = AegisWallet("Bob")
    try:
        w.recover([0,1])
        assert False, "should fail with 2 shares"
    except ValueError:
        pass

def test_no_entropy_blocked():
    w = AegisWallet("Alice")
    try:
        w.sign_payment("lmn1x", 100, "evil", "evil.example", b"")
        assert False
    except ValueError:
        pass
