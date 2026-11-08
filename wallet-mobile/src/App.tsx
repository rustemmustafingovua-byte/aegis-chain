import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { createPasskey, authPasskey, encryptKeys, decryptKeys, localEntropy, assertChallenge, sha256Hex } from "./lib/passkey";
import { hybridGenerate, hybridSign, ledgerTxMessage, signIntent, offlinePacket, behavioralScore } from "./lib/aegis-wallet";
import { splitSecret, recoverSecret, backupJson, parseBackup, secretFingerprint } from "./lib/shamir";
import { bleSupported, bleScanAndRead } from "./lib/ble";
import { toConfIntent } from "./lib/confidential";
import { checkAnchor, loadPin } from "./lib/pin";

type Stored = { iv: string; ct: string; credentialId: string; address: string; protection?: "prf" | "device" };
type TxItem = { hash: string; to: string; amount: string; intent: string; verdict: string; score: number; ts: number };

export default function App() {
  const [keys, setKeys] = useState<any>(null);
  const [lang, setLang] = useState<"ru" | "en">(() => ((localStorage.getItem("aegis.lang") as any) || "ru"));
  const t = (ru: string, en: string) => (lang === "ru" ? ru : en);
  const [address, setAddress] = useState("");
  const [wallets, setWallets] = useState<Stored[]>(() => {
    try {
      const arr = JSON.parse(localStorage.getItem("aegis.wallets") || "[]");
      if (Array.isArray(arr) && arr.length) return arr;
      const single = localStorage.getItem("aegis.wallet");
      return single ? [JSON.parse(single)] : [];
    } catch { return []; }
  });
  const [activeIdx, setActiveIdx] = useState(0);
  const [status, setStatus] = useState("Не инициализировано. Создай Passkey.");
  const [toast, setToast] = useState("");
  const [tab, setTab] = useState<"wallet" | "send" | "history" | "shield">("wallet");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("10");
  const [intent, setIntent] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [privateSecret, setPrivateSecret] = useState("");
  const [domain, setDomain] = useState("marketplace.aegis.local");
  const [signedTx, setSignedTx] = useState<any>(null);
  const [meshPacket, setMeshPacket] = useState("");
  const [qrData, setQrData] = useState("");
  const [recvQr, setRecvQr] = useState("");
  const [balance, setBalance] = useState("—");
  // v1.14: pinned checkpoint = защита от отката/форка истории узлом
  const [anchor, setAnchor] = useState<string>(() => {
    const p = loadPin();
    return p ? `якорь h=${p.height} ${p.blockHash.slice(0, 10)}…` : "якорь не закреплён";
  });
  const [anchorAlert, setAnchorAlert] = useState<string>("");
  const [rpcUrl, setRpcUrl] = useState(() => localStorage.getItem("aegis.rpc") || "");
  const [backup, setBackup] = useState("");
  const [backupInput, setBackupInput] = useState("");
  const [shares, setShares] = useState<any[] | null>(null);
  const [history, setHistory] = useState<TxItem[]>(() => {
    try { return JSON.parse(localStorage.getItem("aegis.history") || "[]"); } catch { return []; }
  });
  const intervalsRef = useRef<number[]>([]);
  const firstTapRef = useRef<number>(Date.now());

  useEffect(() => {
    const w = wallets[activeIdx];
    if (w) {
      setAddress(w.address);
      setStatus(`Кошелёк ${w.address.slice(0, 12)}… (${w.credentialId.slice(0, 8)}…). Аутентифицируйся Passkey.`);
    }
  }, [activeIdx]);

  useEffect(() => {
    if (wallets.length && !address) setAddress(wallets[0].address);
  }, [wallets]);

  useEffect(() => {
    if (!meshPacket) { setQrData(""); return; }
    QRCode.toDataURL(meshPacket.slice(0, 900), { margin: 1, width: 220 }).then(setQrData).catch(() => setQrData(""));
  }, [meshPacket]);

  useEffect(() => {
    if (!address) { setRecvQr(""); return; }
    QRCode.toDataURL(address, { margin: 1, width: 180 }).then(setRecvQr).catch(() => setRecvQr(""));
  }, [address]);

  function showToast(t: string) { setToast(t); setTimeout(() => setToast(""), 2400); }

  async function onCreate() {
    try {
      setStatus("Создание Passkey (Touch ID / Face ID)…");
      const { wrapSecret, credentialId, prf } = await createPasskey();
      const ent = await localEntropy();
      const kp = hybridGenerate();
      const pt = JSON.stringify({
        edPrivate: btoa(String.fromCharCode(...kp.edPrivate)),
        mlSeed: btoa(String.fromCharCode(...kp.mlSeed)),
        address: kp.address,
      });
      const { iv, ciphertext } = await encryptKeys(wrapSecret, ent, pt);
      const entry: Stored = { iv, ct: ciphertext, credentialId, address: kp.address, protection: prf ? "prf" : "device" };
      const next = [...wallets, entry];
      setWallets(next); setActiveIdx(next.length - 1);
      localStorage.setItem("aegis.wallets", JSON.stringify(next));
      localStorage.setItem("aegis.wallet", JSON.stringify(entry));
      setKeys(kp); setAddress(kp.address);
      setStatus(prf
        ? "Кошелёк создан. Ключ зашифрован PRF-секретом Passkey — без Touch ID/Face ID не расшифровать."
        : "Кошелёк создан, но Passkey без PRF: защита только на уровне устройства. Не используй для крупных сумм.");
      showToast("Кошелёк создан");
    } catch (e: any) {
      setStatus(`Passkey create недоступен (${e.message}). Нужен localhost или HTTPS.`);
    }
  }

  async function onUnlock() {
    const s = wallets[activeIdx] ?? null;
    if (!s) return setStatus("Нет сохранённого кошелька");
    try {
      const { wrapSecret, prf } = await authPasskey(s.credentialId);
      const ent = await localEntropy();
      const pt = await decryptKeys(wrapSecret, ent, s.iv, s.ct);
      const parsed = JSON.parse(pt);
      const edPrivate = new Uint8Array([...atob(parsed.edPrivate)].map((c) => c.charCodeAt(0)));
      const kp = hybridGenerate(edPrivate);
      setKeys(kp); setAddress(kp.address);
      setStatus(prf
        ? t("Разблокировано через Passkey PRF. Сессия эфемерная — ключ стирается из RAM.", "Unlocked via passkey PRF. Ephemeral session — key wipes from RAM.")
        : t("Разблокировано. PRF не поддерживается: защита устройства, не железа.", "Unlocked. No PRF: device-level protection only."));
      showToast(t("Разблокировано", "Unlocked"));
      const lockSec = Number(localStorage.getItem("aegis.lockSec") || 60);
      setTimeout(() => setKeys(null), lockSec * 1000);
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
    let intentVal = intent || "платёж";
    if (isPrivate) {
      if (!privateSecret) return setStatus("Укажи shared secret для private intent");
      intentVal = await toConfIntent(intentVal, privateSecret);
    }
    const tx = signIntent(keys, { from: keys.address, to, amount, intent: intentVal, domain: domain || "aegis.local", expiry: Math.floor(Date.now() / 1000) + 120 }, ent);
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
      const rpc = rpcUrl || localStorage.getItem("aegis.rpc") || "";
      if (!rpc) { setBalance("RPC не задан — укажи в настройках (Shield tab)"); return; }
      const r = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "aeg_getBalance", params: [address] }) });
      const j = await r.json();
      setBalance(j.result != null ? String(j.result) : "err: " + j.error?.message);
      // v1.14: сверяем подписанный чекпоинт с закреплённым — ловим rollback/fork
      try {
        const cr = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "aeg_checkpointLatest", params: [] }) });
        const cj = await cr.json();
        const a = checkAnchor(cj.result?.checkpoint);
        setAnchor(a.text);
        setAnchorAlert(a.alert ?? "");
        if (a.verdict === "fork" || a.verdict === "rollback") showToast(lang === "ru" ? "⚠ узел показал другую историю" : "⚠ node served a different history");
      } catch { /* checkpoint optional */ }
    } catch (e: any) { setBalance("err: " + e.message); }
  }

  function saveRpc() { localStorage.setItem("aegis.rpc", rpcUrl); showToast("RPC сохранён"); }

  function onBackup() {
    if (!keys) return setStatus("Сначала разблокируй для бэкапа");
    // split edPrivate (32 bytes) 3-of-5
    const s = splitSecret(keys.edPrivate, 5, 3);
    setShares(s);
    setBackup(backupJson(s));
    setStatus(`Бэкап Shamir 3-of-5 создан. Fingerprint ${secretFingerprint(keys.edPrivate)}. Распечатай 2 шары, 1 — HSM, 1 — доверенное лицо, 1 — телефон.`);
  }

  async function onRestore() {
    try {
      const s = parseBackup(backupInput);
      if (s.length < 3) throw new Error("нужно минимум 3 шары");
      const secret = recoverSecret(s, 32);
      const kp = hybridGenerate(secret);
      setKeys(kp); setAddress(kp.address);
      setStatus(`Восстановлено из Shamir. Адрес ${kp.address}. Создай новый Passkey чтобы перешифровать.`);
    } catch (e: any) { setStatus(`Восстановление неудалось: ${e.message}`); }
  }

  async function rpcCall(method: string, params: any[]) {
    const rpc = rpcUrl || localStorage.getItem("aegis.rpc") || "";
    if (!rpc) throw new Error("RPC endpoint не задан");
    const r = await fetch(rpc, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return r.json();
  }

  async function onSendRpc() {
    if (!keys) return setStatus("Сначала разблокируй кошелёк");
    if (!to || !amount) return setStatus("Укажи получателя и сумму");
    try {
      const acct = await rpcCall("aeg_getAccount", [address]);
      if (!acct.result) return setStatus("Адрес ещё не в цепи — получи faucet (Shield tab)");
      const nonce = acct.result.nonce ?? 0;
      // v1.12: quote the live base fee instead of hardcoding 1000
      const gas = await rpcCall("aeg_gasPrice", []);
      const fee = gas.result?.baseFee ?? "1000";
      // canonical ledger message — exactly what core-ts/ledger.ts verifies
      const body: any = {
        from: address, to, amount: BigInt(amount).toString(), fee, nonce,
        intent: intent || "платёж", domain: domain || "aegis.local",
        timestamp: Date.now(), data: "",
      };
      const msg = ledgerTxMessage(body);
      const sig = hybridSign(keys, msg);
      const tx = {
        ...body, sig,
        mlPublicKeyB64: btoa(String.fromCharCode(...keys.mlPublicKey)),
        edPublicB64: btoa(String.fromCharCode(...keys.edPublic)), // first-spend key binding
      };
      // If this account has a bound passkey, the server requires an assertion over this exact tx.
      let assertion: any = undefined;
      const info = await rpcCall("aeg_passkeyInfo", [address]).catch(() => null);
      if (info?.result?.length) {
        const challengeHex = await sha256Hex(msg);
        assertion = await assertChallenge(challengeHex, info.result[0].credentialId);
      }
      const j = await rpcCall("aeg_sendTx", assertion ? [tx, assertion] : [tx]);
      if (j.result?.accepted) {
        setStatus(`Отправлено в сеть (fee ${fee}, mempool ${j.result.mempool})`);
        persistHistory({ hash: sig.hybrid.slice(0, 16), to, amount, intent: intent || "платёж", verdict: "sent", score: 100, ts: Date.now() });
      } else {
        setStatus(`Сеть отклонила: ${j.error?.message}`);
      }
    } catch (e: any) { setStatus(`Отправка неудалась: ${e.message}`); }
  }

  function copyText(t: string) { navigator.clipboard.writeText(t); showToast("Скопировано"); }

  async function onScan() {
    try {
      const bd: any = (window as any).BarcodeDetector;
      if (!bd) { setStatus("BarcodeDetector не доступен в этом браузере — вставь адрес вручную"); return; }
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const video = document.createElement("video");
      video.srcObject = stream; await video.play();
      const det = new bd({ formats: ["qr_code"] });
      const start = Date.now();
      while (Date.now() - start < 8000) {
        const codes = await det.detect(video);
        if (codes?.length) {
          const txt = codes[0].rawValue || "";
          stream.getTracks().forEach((t) => t.stop());
          if (txt.startsWith("aeg1")) { setTo(txt); showToast("Адрес отсканирован"); }
          else { setTo(txt); showToast("QR считан — как адрес"); }
          return;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      stream.getTracks().forEach((t) => t.stop());
      setStatus("QR не найден за 8с");
    } catch (e: any) { setStatus(`Сканер недоступен: ${e.message}`); }
  }

  async function onBleScan() {
    try {
      if (!bleSupported()) { setStatus("Web Bluetooth не поддерживается (iOS Safari) — используй QR"); return; }
      setStatus("BLE scan: выбери AEGIS mesh device…");
      const json = await bleScanAndRead();
      try {
        const pkt = JSON.parse(json);
        if (pkt.to) { setTo(pkt.to); setAmount(String(pkt.amount ?? amount)); setIntent(String(pkt.intent ?? intent)); showToast("BLE пакет принят"); }
        else setMeshPacket(json);
        setStatus("BLE mesh-пакет принят и распарсен");
      } catch { setMeshPacket(json); showToast("BLE пакет принят (сырьё)"); }
    } catch (e: any) { setStatus(`BLE недоступен: ${e.message}`); }
  }

  return (
    <div className="app">
      <div className="hero">
        <div className="logo"><div className="shield">🛡️</div><b>AEGIS Wallet</b><span className="badge">v1.14</span><span className="badge" style={{ background: "rgba(56,225,255,.1)" }}>Passkey</span>
          <button className="secondary" style={{ width: "auto", padding: "6px 10px", marginLeft: 6 }} onClick={() => { const nl = lang === "ru" ? "en" : "ru"; setLang(nl); localStorage.setItem("aegis.lang", nl); }}>{lang === "ru" ? "EN" : "RU"}</button></div>
        <h1>Щит Афины.<br />Ключи — в железе, намерение — на экране.</h1>
        <p>Hybrid Ed25519 + ML-DSA-65 · Intent-Bound · Offline Mesh. Агент не подпишет за тебя: нужны Passkey + живой человек + домен.</p>
      </div>

      <div className="card">
        <h3>Адрес</h3>
        <div className="mono" onClick={tap}>{address || "— создай Passkey —"}</div>
        {wallets.length > 1 && (
          <select value={activeIdx} onChange={(e) => { setActiveIdx(Number(e.target.value)); setKeys(null); }} style={{ marginTop: 6 }}>
            {wallets.map((w, i) => (<option key={w.address + i} value={i}>{w.address.slice(0, 20)}… ({w.credentialId.slice(0, 6)})</option>))}
          </select>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <span className="badge">баланс <b className="mono">{balance}</b></span>
          <button className="secondary btn" style={{ padding: "8px 10px" }} onClick={checkBalance}>обновить</button>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>{anchor} {anchorAlert ? <span className="warn">· {anchorAlert}</span> : null}</div>
        <div className="hint" style={{ marginTop: 8 }}>{status}</div>
        <div className="grid" style={{ marginTop: 10 }}>
          <button className="btn" onClick={onCreate}>Создать Passkey + кошелёк</button>
          <button className="btn secondary" onClick={onUnlock}>Разблокировать</button>
          <button className="btn secondary" onClick={() => copyText(address)} disabled={!address}>Копировать адрес</button>
        </div>
        <label style={{ marginTop: 6 }}>Lock timeout</label>
        <select value={localStorage.getItem("aegis.lockSec") || "60"} onChange={(e) => localStorage.setItem("aegis.lockSec", e.target.value)} style={{ width: "100%" }}>
          <option value="30">30s</option><option value="60">60s</option><option value="120">120s</option>
        </select>
        <div className="hint" style={{ marginTop: 8 }}>{keys ? <span className="ok">● сессия активна {keys.address.slice(0, 8)}…</span> : <span className="warn">● сессия закрыта — ключи в памяти стёрты</span>}</div>
        {recvQr && (<div className="qr"><img src={recvQr} alt="receive QR" style={{ width: 160, height: 160 }} /></div>)}
        <div className="hint">Принимай — покажи QR, отправитель отсканирует 📷</div>
      </div>

      <div className="card">
        <h3>Токены</h3>
        <div className="list">
          <div className="item"><div><b>AEGIS</b><div className="hint">native · 6 decimals</div></div><b className="mono">{balance}</b></div>
          <div className="item"><div><b>USDC</b><div className="hint">via AMM estimate (pool AEGIS/USDC)</div></div><b className="mono">{balance !== "—" ? "≈ " + balance : "—"}</b></div>
        </div>
        <div className="hint" style={{ marginTop: 6 }}>USDC оценка — по цене пула (quote), не отдельная нативная монета. Нативный USDC живёт на Base (BridgeVault).</div>
      </div>

      {tab === "send" && (
        <div className="card">
          <h3>Intent-bound платёж</h3>
          <label>Кому (aeg1…)</label>
          <div style={{ display: "flex", gap: 6 }}><input value={to} onChange={(e) => setTo(e.target.value)} placeholder="aeg1…" style={{ flex: 1 }} />
          <button className="secondary" style={{ width: "auto" }} onClick={onScan}>📷 scan</button>
          <button className="secondary" style={{ width: "auto" }} onClick={onBleScan}>📡 BLE</button></div>
          <label>Сумма (base units, 6 decimals)</label><input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1000000" />
          <label>Зачем (intent — видно человеку и сети)</label><input value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="продажа велосипеда #4721" />
          <label><input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} style={{ width: "auto" }} /> private intent (шифр, сеть видит только cipher)</label>
          {isPrivate && <><label>Shared secret (out-of-band, QR)</label><input value={privateSecret} onChange={(e) => setPrivateSecret(e.target.value)} placeholder="shared-secret" /></>}
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
              <button className="btn" onClick={onSendRpc} style={{ marginTop: 8 }}>Отправить в сеть (RPC)</button>
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
          <div className="row" style={{ marginBottom: 8 }}>
            <button className="secondary" style={{ padding: "8px 10px" }} onClick={() => {
              const csv = "hash,to,amount,intent,verdict,score,ts\n" + history.map(h => `${h.hash},${h.to},${h.amount},"${h.intent}",${h.verdict},${h.score},${h.ts}`).join("\n");
              const blob = new Blob([csv], { type: "text/csv" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a"); a.href = url; a.download = "aegis-history.csv"; a.click();
              URL.revokeObjectURL(url);
            }}>Export CSV</button>
          </div>
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
          <details open><summary>Сеть (RPC)</summary>
            <label>RPC endpoint</label>
            <input value={rpcUrl} onChange={(e) => setRpcUrl(e.target.value)} placeholder="http://127.0.0.1:8899/rpc" />
            <button className="btn secondary" onClick={saveRpc} style={{ marginTop: 6 }}>Сохранить RPC</button>
            <div className="hint" style={{ marginTop: 6 }}>Баланс, nonce и отправка tx идут через этот endpoint.</div>
          </details>
          <details><summary>Бэкап Shamir 3-of-5</summary>
            <div className="hint" style={{ marginTop: 6 }}>Раздели приватный ключ на 5 шар (3 восстанавливают). Храни в разных местах.</div>
            <button className="btn" onClick={onBackup} style={{ marginTop: 8 }}>Создать бэкап</button>
            {backup && <><textarea rows={8} value={backup} readOnly style={{ marginTop: 8 }} /><button className="btn secondary" onClick={() => copyText(backup)}>Скопировать бэкап</button></>}
            <label style={{ marginTop: 10 }}>Восстановить из JSON (3+ шары)</label>
            <textarea rows={6} value={backupInput} onChange={(e) => setBackupInput(e.target.value)} placeholder='{"v":"aegis-shamir-3/5","shares":[…]}' />
            <button className="btn secondary" onClick={onRestore}>Восстановить</button>
            {shares && (<div className="hint" style={{ marginTop: 6 }}>Шары: {shares.map((s: any) => `x=${s.x}`).join(", ")}</div>)}
          </details>
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
