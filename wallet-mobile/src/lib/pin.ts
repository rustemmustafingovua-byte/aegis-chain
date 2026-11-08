/**
 * Checkpoint pinning для кошелька (v1.14).
 *
 * Копия чистой логики core-ts/pinning.ts: кошелёк живёт в отдельном бандле
 * (Vite/браузер), поэтому не импортирует node-модули ядра. Держим в синхроне —
 * оба варианта покрыты одними и теми же правилами:
 *   rollback (ниже пина) и fork (та же высота, другой blockHash) НЕ перезаписывают пин.
 */

export type PinAnchor = { height: number; blockHash: string; stateRoot: string; nullifierRoot?: string };
export type PinVerdict = "pin" | "same" | "advance" | "rollback" | "fork";
export type PinAssessment = { verdict: PinVerdict; pin: PinAnchor; alerts: string[]; rollbackDepth?: number };

const KEY = "aegis.checkpointPin";

export function loadPin(): PinAnchor | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return typeof p?.height === "number" && typeof p?.blockHash === "string" ? (p as PinAnchor) : null;
  } catch { return null; }
}

export function savePin(p: PinAnchor): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage disabled */ }
}

export function assessCheckpoint(prev: PinAnchor | null, cp: PinAnchor, retention = 256): PinAssessment {
  const alerts: string[] = [];
  if (!prev) return { verdict: "pin", pin: cp, alerts };
  if (cp.height === prev.height) {
    if (cp.blockHash === prev.blockHash && cp.stateRoot === prev.stateRoot) return { verdict: "same", pin: prev, alerts };
    alerts.push(
      `fork at height ${cp.height}: pinned ${prev.blockHash.slice(0, 12)}… vs node ${cp.blockHash.slice(0, 12)}…`,
    );
    return { verdict: "fork", pin: prev, alerts };
  }
  if (cp.height < prev.height) {
    const depth = prev.height - cp.height;
    alerts.push(`rollback: pinned height ${prev.height}, node served ${cp.height} (−${depth})`);
    if (depth >= retention) alerts.push(`rollback depth ${depth} ≥ retention ${retention}`);
    return { verdict: "rollback", pin: prev, alerts, rollbackDepth: depth };
  }
  if (cp.height - prev.height > retention) {
    alerts.push(`large gap ${prev.height} → ${cp.height} (> ${retention}); verify headers from the pinned blockHash`);
  }
  return { verdict: "advance", pin: cp, alerts };
}

/**
 * Проверить якорь из ответа aeg_checkpointLatest и обновить пин.
 * Возвращает человекочитаемый статус для UI.
 */
export function checkAnchor(checkpoint: any): { verdict: PinVerdict; text: string; alert: string | null } {
  if (!checkpoint || typeof checkpoint.height !== "number") {
    return { verdict: "pin", text: "чекпоинт недоступен", alert: null };
  }
  const prev = loadPin();
  const res = assessCheckpoint(prev, {
    height: checkpoint.height,
    blockHash: checkpoint.blockHash,
    stateRoot: checkpoint.stateRoot,
    nullifierRoot: checkpoint.nullifierRoot,
  });
  if (res.verdict === "pin" || res.verdict === "same" || res.verdict === "advance") savePin(res.pin);
  const text = `якорь h=${res.pin.height} ${res.pin.blockHash.slice(0, 10)}…`;
  return { verdict: res.verdict, text, alert: res.alerts.length ? res.alerts.join(" · ") : null };
}
