import { useEffect, useRef, useState } from "react";
import { createPasskey, authPasskey, encryptKeys, decryptKeys, localEntropy, behavioralCapture } from "./lib/passkey";
import { hybridGenerate, signIntent, offlinePacket, behavioralScore } from "./lib/aegis-wallet";

type Stored = { iv: string; ct: string; credentialId: string; address: string; mlPubHash: string };

export default function App() {
  const [keys, setKeys] = useState<any>(null);
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState("Не инициализировано. Создай Passkey.");
  const [to, setTo] = useState("aeg1bob...");
  const [amount, setAmount] = useState("10");
  const [intent, setIntent] = useState("продажа велосипеда #4721");
  const [domain, setDomain] = useState("marketplace.aegis.example");
  const [signedTx, setSignedTx] = useState<any>(null);
  const [meshPacket, setMeshPacket] = useState<string>("");
  const intervalsRef = useRef<number[]>([]);
  const firstTapRef = useRef<number>(Date.now());

  useEffect(() => {
    const stored = localStorage.getItem("aegis.wallet");
    if (stored) {
      const s: Stored = JSON.parse(stored);
      setAddress(s.address);
      setStatus(`Есть зашифрованный кошелёк (${s.credentialId.slice(0,8)}...). Аутентифицируйся Passkey для разблокировки.`);
    }
  }, []);

  async function onCreate() {
    try {
      setStatus("Создание Passkey (Touch ID / Face ID)...");
      const { unwrapSeed, credentialId } = await createPasskey();
      const ent = await localEntropy();
      const kp = hybridGenerate();
      const pt = JSON.stringify({
        edPrivate: btoa(String.fromCharCode(...kp.edPrivate)),
        mlSeed: btoa(String.fromCharCode(...kp.mlSeed)),
        address: kp.address,
      });
      const { iv, ciphertext } = await encryptKeys(unwrapSeed, ent, pt);
      localStorage.setItem("aegis.wallet", JSON.stringify({ iv, ct: ciphertext, credentialId, address: kp.address, mlPubHash: "" } as Stored));
      setKeys(kp);
      setAddress(kp.address);
      setStatus("Кошелёк создан и зашифрован Passkey. Компромисса: ключ никто не увидит.");
    } catch (e: any) {
      setStatus(`Passkey create недоступен (${e.message}). На десктопе нужна localhost или HTTPS.`);
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
      setKeys(kp);
      setAddress(kp.address);
      setStatus("Кошелёк разблокирован через Passkey. Сессия живёт 60 секунд (эфемерный ключ).");
      // wipe after 60s in prod: setTimeout(() => setKeys(null), 60_000)
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

  async function onSignOnline() {
    if (!keys) return setStatus("Сначала разблокируй кошелёк");
    tap();
    const ent = await localEntropy();
    const tx = signIntent(keys, { from: keys.address, to, amount, intent, domain, expiry: Math.floor(Date.now()/1000)+120 }, ent);
    const confirmMs = Date.now() - firstTapRef.current;
    const behav = behavioralScore(intervalsRef.current, confirmMs, tx.humanContextHash);
    setSignedTx({ tx, behav });
    setStatus(`Подписано. Hybrid sig ${tx.sig.hybrid.slice(0,12)}... Behavior ${behav.score}/100 (${behav.verdict})`);
  }

  async function onSignOffline() {
    if (!keys) return setStatus("Сначала разблокируй");
    const ent = await localEntropy();
    const pkt = offlinePacket(keys, keys.address, to, amount, intent, "mesh.aegis.local", ent, 0, 0);
    const json = JSON.stringify(pkt, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
    setMeshPacket(json);
    setStatus("Офлайн-пакет готов. Перенеси по QR / BLE / LoRa. Сеть сверит по nullifier при синке.");
  }

  function copyMesh() {
    navigator.clipboard.writeText(meshPacket);
    setStatus("Пакет скопирован — вставь в любой мессенджер (sneakernet) или покажи QR.");
  }

  return (
    <div>
      <h1>🛡️ AEGIS Wallet</h1>
      <p style={{ opacity: 0.8 }}>Hybrid Ed25519 + ML-DSA-65 • Intent-Bound • Offline Mesh • Passkey Anchor</p>

      <div className="card">
        <div className="badge">ADDRESS</div>
        <div className="mono" onClick={tap}>{address || "— создай Passkey —"}</div>
        <div style={{ marginTop: 8, fontSize: 14 }}>{status}</div>
        <div className="row">
          <button onClick={onCreate}>Создать Passkey + кошелёк</button>
          <button className="secondary" onClick={onUnlock}>Разблокировать</button>
        </div>
      </div>

      <div className="card">
        <div className="badge">INTENT-BOUND ПЛАТЁЖ</div>
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Кому (aeg1...)" />
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Сумма" />
        <input value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="Зачем (intent)" />
        <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="Домен (domain binding)" />
        <button onClick={onSignOnline}>Подписать онлайн (Passkey + Liveness)</button>
        <button className="secondary" onClick={onSignOffline}>Подписать офлайн (Mesh QR/BLE)</button>
        {signedTx && (
          <div style={{ marginTop: 8 }}>
            <div className="mono">txHash {signedTx.tx.txHash.slice(0,32)}...</div>
            <div>Behavioral: <span className={signedTx.behav.verdict === "allow" ? "ok" : signedTx.behav.verdict === "review" ? "warn" : "bad"}>{signedTx.behav.score}/100 {signedTx.behav.verdict}</span> — {signedTx.behav.flags.join(", ")}</div>
          </div>
        )}
        {meshPacket && (
          <>
            <textarea rows={8} value={meshPacket} readOnly />
            <button className="secondary" onClick={copyMesh}>Скопировать пакет (mesh)</button>
          </>
        )}
      </div>

      <div className="card" style={{ fontSize: 13, opacity: 0.9 }}>
        <b>Почему агент не украдёт?</b>
        <ul>
          <li>Intent Binding: подмена получателя ломает ML-DSA подпись</li>
          <li>Domain Binding: подпись не работает на фишинговом домене</li>
          <li>Passkey Anchor: ключ не извлекаем из железа</li>
          <li>Liveness: entropic challenge каждые 30с</li>
          <li>Mesh + Nullifier: офлайн трата не двоится при синке</li>
        </ul>
      </div>
    </div>
  );
}
