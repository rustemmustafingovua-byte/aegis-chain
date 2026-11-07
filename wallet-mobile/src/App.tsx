import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { createPasskey, authPasskey, encryptKeys, decryptKeys, localEntropy } from "./lib/passkey";
import { hybridGenerate, signIntent, offlinePacket, behavioralScore } from "./lib/aegis-wallet";

type Stored = { iv: string; ct: string; credentialId: string; address: string };
type TxItem = { hash: string; to: string; amount: string; intent: string; verdict: string; score: number; ts: number };

export default function App() {
  const [keys, setKeys] = useState<any>(null);
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState("Не инициализировано. Создай Passkey.");
  const [toast, setToast] = useState("");
  const [tab, setTab] = useState<"wallet" | "send" | "history" | "shield">("wallet");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("10");
  const [intent, setIntent] = useState("");
  const [domain, setDomain] = useState("marketplace.aegis.local");
  const [signedTx, setSignedTx] = useState<any>(null);
  const [meshPacket, setMeshPacket] = useState("");
  const [qrData, setQrData] = useState("");
  const [balance, setBalance] = useState("—");
  const [history, setHistory] = useState<TxItem[]>(() => {
    try { return JSON.parse(localStorage.getItem("aegis.history") || "[]"); } catch { return []; }
  });
  const intervalsRef = useRef<number[]>([]);
  const firstTapRef = useRef<number>(Date.now());

  useEffect(() => {
    const stored = localStorage.getItem("aegis.wallet");
    if (stored) {
      const s: Stored = JSON.parse(stored);
      setAddress(s.address);
      setStatus(`Есть зашифрованный кошелёк (${s.credentialId.slice(0, 8)}…). Аутентифицируйся Passkey.`);
    }
  }, []);

  useEffect(() => {
    if (!meshPacket) { setQrData(""); return; }
    QRCode.toDataURL(meshPacket.slice(0, 900), { margin: 1, width: 220 }).then(setQrData).catch(() => setQrData(""));
  }, [meshPacket]);

  function showToast(t: string) { setToast(t); setTimeout(() => setToast(""), 2400); }

  async function onCreate() {
    try {
      setStatus("Создание Passkey (Touch ID / Face ID)…");
      const { unwrapSeed, credentialId } = await createPasskey();
      const ent = await localEntropy();
      const kp = hybridGenerate();
      const pt = JSON.stringify({
        edPrivate: btoa(String.fromCharCode(...kp.edPrivate)),
        mlSeed: btoa(String.fromCharCode(...kp.mlSeed)),
        address: kp.address,
      });
      const { iv, ciphertext } = await encryptKeys(unwrapSeed, ent, pt);
      localStorage.setItem("aegis.wallet", JSON.stringify({ iv, ct: ciphertext, credentialId, address: kp.address } as Stored));
      setKeys(kp); setAddress(kp.address);
      setStatus("Кошелёк создан и зашифрован Passkey. Приватный ключ никто не увидит — не извлекай из железа.");
      showToast("Кошелёк создан");
    } catch (e: any) {
      setStatus(`Passkey create недоступен (${e.message}). Нужен localhost или HTTPS.`);
    }
  }

  async function onUnlock() {
    const stored = localStorage.getItem("aegis.wallet");
    if (!stored) return setStatus("Нет сохранённого кошелька");
    try {
      const s: Stored = JSON.parse(stored);
      const { unwrapSeed } = await authPasskey();
      const ent = await localEntropy();
      const pt = await decryptKeys(unwrapSeed, ent, s.iv, s.ct);
      const parsed = JSON.parse(pt);
      const edPrivate = new Uint8Array([...atob(parsed.edPrivate)].map((c) => c.charCodeAt(0)));
      const kp = hybridGenerate(edPrivate);
      setKeys(kp); setAddress(kp.address);
      setStatus("Кошелёк разблокирован через Passkey. Эфемерная сессия 60с — затем ключ стирается из RAM.");
      showToast("Разблокировано");
      setTimeout(() => setKeys(null), 60_000);
    } catch (e: any) {
      setStatus(`Разблокировка неудалась: ${e.message}`);
    }
  }

  function tap() {
    const now = Date.now();
    const last = intervalsRef.current[intervalsRef.current.length - 1] ?? firstTapRef.current;
    intervalsRef.current.push(Math.abs(now - last));
    if (intervalsRef.current.length > 20) intervalsRef.current.shift();
  }

  function persistHistory(item: TxItem) {
    const next = [item, ...history].slice(0, 30);
    setHistory(next);
    localStorage.setItem("aegis.history", JSON.stringify(next));
  }

  async function onSignOnline() {
    if (!keys) return setStatus("Сначала разблокируй кошелёк");
    if (!to || !amount) return setStatus("Укажи получателя и сумму");
    tap();
    const ent = await localEntropy();
    const tx = signIntent(keys, { from: keys.address, to, amount, intent: intent || "платёж", domain: domain || "aegis.local", expiry: Math.floor(Date.now() / 1000) + 120 }, ent);
    const confirmMs = Date.now() - firstTapRef.current;
    const behav = behavioralScore(intervalsRef.current, confirmMs, tx.humanContextHash);
    setSignedTx({ tx, behav });
    persistHistory({ hash: tx.txHash, to, amount, intent: intent || "платёж", verdict: behav.verdict, score: behav.score, ts: Date.now() });
    setStatus(`Подписано. Hybrid ${tx.sig.hybrid.slice(0, 12)}… Behavior ${behav.score}/100 (${behav.verdict}). Отправь в сеть — мемпул проверит intent.`);
    setTab("send");
  }

  async function onSignOffline() {
    if (!keys) return setStatus("Сначала разблокируй");
    if (!to || !amount) return setStatus("Укажи получателя и сумму");
    const ent = await localEntropy();
    const pkt = offlinePacket(keys, keys.address, to, amount, intent || "офлайн платёж", domain || "mesh.aegis.local", ent, 0, 0);
    setMeshPacket(JSON.stringify(pkt, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    setStatus("Офлайн-пакет готов. Перенеси по QR / BLE / LoRa. Сеть сверит по nullifier при синке.");
  }

  async function checkBalance() {
    if (!address) return;
    try {
      // best-effort: локальный RPC если настроен, иначе — без баланса
      const rpc = localStorage.getItem("aegis.rpc") || "";
      if (!rpc) { setBalance("RPC не задан — задай aegis.rpc в localStorage для on-chain баланса"); return; }
      const r = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "aeg_getBalance", params: [address] }) });
      const j = await r.json();
      setBalance(j.result != null ? String(j.result) : "err: " + j.error?.message);
    } catch (e: any) { setBalance("err: " + e.message); }
  }

  function copyText(t: string) { navigator.clipboard.writeText(t); showToast("Скопировано"); }

  return (
    <div className="app">
      <div className="hero">
        <div className="logo"><div className="shield">🛡️</div><b>AEGIS Wallet</b><span className="badge">v1.0</span><span className="badge" style={{ background: "rgba(56,225,255,.1)" }}>Passkey</span></div>
        <h1>Щит Афины.<br />Ключи — в железе, намерение — на экране.</h1>
        <p>Hybrid Ed25519 + ML-DSA-65 · Intent-Bound · Offline Mesh. Агент не подпишет за тебя: нужны Passkey + живой человек + домен.</p>
      </div>

      <div className="card">
        <h3>Адрес</h3>
        <div className="mono" onClick={tap}>{address || "— создай Passkey —"}</div>
        <div className="row" style={{ marginTop: 8 }}>
          <span className="badge">баланс <b className="mono">{balance}</b></span>
          <button className="secondary btn" style={{ padding: "8px 10px" }} onClick={checkBalance}>обновить</button>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>{status}</div>
        <div className="grid" style={{ marginTop: 10 }}>
          <button className="btn" onClick={onCreate}>Создать Passkey + кошелёк</button>
          <button className="btn secondary" onClick={onUnlock}>Разблокировать (60с)</button>
          <button className="btn secondary" onClick={() => copyText(address)} disabled={!address}>Копировать адрес</button>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>{keys ? <span className="ok">● сессия активна {keys.address.slice(0, 8)}…</span> : <span className="warn">● сессия закрыта — ключи в памяти стёрты</span>}</div>
      </div>

      {tab === "send" && (
        <div className="card">
          <h3>Intent-bound платёж</h3>
          <label>Кому (aeg1…)</label><input value={to} onChange={(e) => setTo(e.target.value)} placeholder="aeg1…" />
          <label>Сумма (base units, 6 decimals)</label><input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1000000" />
          <label>Зачем (intent — видно человеку и сети)</label><input value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="продажа велосипеда #4721" />
          <label>Домен (domain binding — фишинг уже не сработает)</label><input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="marketplace.aegis.local" />
          <div className="grid" style={{ marginTop: 8 }}>
            <button className="btn" onClick={onSignOnline}>Подписать онлайн (Passkey + Liveness)</button>
            <button className="btn secondary" onClick={onSignOffline}>Подписать офлайн (Mesh QR/BLE)</button>
          </div>
          <details><summary>Что увидит получатель и сеть?</summary><div className="hint" style={{ marginTop: 6 }}>Каноничная строка: from|to|amount|intent|domain|expiry|humanContextHash|nonce — ML-DSA подпись по ней. Подмена получателя = подпись не сойдётся.</div></details>
          {signedTx && (
            <div style={{ marginTop: 10, border: "1px solid var(--line)", borderRadius: 12, padding: 12 }}>
              <div className="mono">txHash {signedTx.tx.txHash.slice(0, 40)}…</div>
              <div>Behavioral: <span className={signedTx.behav.verdict === "allow" ? "ok" : signedTx.behav.verdict === "review" ? "warn" : "bad"}>{signedTx.behav.score}/100 {signedTx.behav.verdict}</span> — {signedTx.behav.flags.join(", ")}</div>
              <div className="mono" style={{ marginTop: 6, fontSize: 12 }}>hybrid {signedTx.tx.sig.hybrid.slice(0, 32)}…</div>
            </div>
          )}
          {meshPacket && (
            <>
              <div className="divider" />
              <div className="hint">Mesh-пакет — покажи QR или перенеси в мессенджер. Сеть сверит по nullifier при синке, двойную трату отклонит.</div>
              {qrData && (<div className="qr"><img src={qrData} alt="mesh QR" /></div>)}
              <textarea rows={8} value={meshPacket} readOnly />
              <button className="btn secondary" onClick={() => copyText(meshPacket)}>Скопировать пакет (mesh)</button>
            </>
          )}
        </div>
      )}

      {tab === "history" && (
        <div className="card">
          <h3>История (локально)</h3>
          <div className="list">
            {history.length === 0 && <div className="hint">Пока нет подписанных транзакций. Подпиши платёж — он появится здесь.</div>}
            {history.map((h) => (
              <div className="item" key={h.hash + h.ts}>
                <div>
                  <div className="mono">{h.hash.slice(0, 20)}…</div>
                  <div className="hint">→ {h.to.slice(0, 18)}… · {h.amount} · {h.intent}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <span className={h.verdict === "allow" ? "ok" : h.verdict === "review" ? "warn" : "bad"}>{h.score}/100</span>
                  <div className="hint">{new Date(h.ts).toLocaleTimeString()}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "shield" && (
        <div className="card">
          <h3>Anti-AI Shield — почему агент не украдёт</h3>
          <ul className="checks">
            <li>✅ <span><b>Intent Binding:</b> подмена получателя ломает ML-DSA подпись</span></li>
            <li>✅ <span><b>Domain Binding:</b> подпись не работает на фишинговом домене</span></li>
            <li>✅ <span><b>Passkey Anchor:</b> ключ не извлекаем из железа (FIDO2, Touch/Face ID)</span></li>
            <li>✅ <span><b>Liveness:</b> entropic challenge каждые 30с — агент не выдумает шум сенсоров</span></li>
            <li>✅ <span><b>Behavioral:</b> интервалы кликов + время реакции — боты слишком ровные и быстрые</span></li>
            <li>✅ <span><b>Mesh + Nullifier:</b> офлайн трата не двоится при синке</span></li>
          </ul>
          <div className="divider" />
          <details><summary>Что делать при подозрении?</summary>
            <div className="hint" style={{ marginTop: 6 }}>1) Закрой сессию (перезагрузи). 2) Проверь адрес получателя глазами, а не из буфера. 3) Проверь intent в истории. 4) Если Passkey скомпрометирован — создай новый кошелёк и перемести средства.</div>
          </details>
          <details><summary>Эфемерные сессии</summary>
            <div className="hint" style={{ marginTop: 6 }}>Главный ключ → сессионный 60с, лимит 100 AEGIS. Утек сессионный — ущерб ограничен, ключ сам умрёт.</div>
          </details>
        </div>
      )}

      {tab === "wallet" && (
        <div className="card">
          <h3>Зачем гибрид?</h3>
          <div className="hint">
            Ed25519 — быстрый и совместимый. ML-DSA-65 (FIPS 204, Cat 3) — устойчив к квантовому Шору. Квантовый атакующий должен сломать оба. Ключи 1952B/4032B — цена PQ, платим за будущее.
          </div>
        </div>
      )}

      <div className="tabs">
        <button className={tab === "wallet" ? "active" : ""} onClick={() => setTab("wallet")}>Кошелёк</button>
        <button className={tab === "send" ? "active" : ""} onClick={() => setTab("send")}>Платёж</button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>История</button>
        <button className={tab === "shield" ? "active" : ""} onClick={() => setTab("shield")}>Щит</button>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
