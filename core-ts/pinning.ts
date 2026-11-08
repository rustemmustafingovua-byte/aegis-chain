/**
 * AEGIS Checkpoint Pinning (v1.14) — обнаружение отката и форка.
 *
 * Checkpoint-подписи доказывают, что состояние подписано валидаторами, но клиент,
 * который каждый раз просто спрашивает «последний checkpoint», не замечает, что
 * узел (или сеть) показал ему **другую историю**: откатился на старую высоту или
 * подсунул форк с тем же номером блока.
 *
 * Пиннинг: клиент запоминает последний проверенный checkpoint и сравнивает.
 *   - та же высота, тот же blockHash/stateRoot → ok
 *   - выше → ok, пин обновляется
 *   - ниже → ROLLBACK (узел пытается откатить историю) — пин НЕ понижаем
 *   - та же высота, другой blockHash/stateRoot → FORK — пин НЕ перезаписываем
 *
 * Модуль чистый (без fs/сети), чтобы одинаково работать в node-клиенте,
 * браузере и мобильном кошельке.
 */

export type PinAnchor = {
  height: number;
  blockHash: string;
  stateRoot: string;
  nullifierRoot?: string;
};

export type PinVerdict = "pin" | "same" | "advance" | "rollback" | "fork";

export type PinAssessment = {
  verdict: PinVerdict;
  /** anchor to store from now on (never the suspicious one on rollback/fork) */
  pin: PinAnchor;
  /** human-readable warnings for UI; empty when everything is consistent */
  alerts: string[];
  /** how many blocks behind the trusted pin the presented checkpoint is */
  rollbackDepth?: number;
};

/**
 * @param prev  previously pinned anchor (null on first contact)
 * @param cp    checkpoint presented by the node (already signature-verified!)
 * @param retention  how many checkpoints the node keeps (default 256); a jump larger
 *                   than this means the client cannot prove continuity from the pin
 */
export function assessCheckpoint(prev: PinAnchor | null, cp: PinAnchor, retention = 256): PinAssessment {
  const alerts: string[] = [];
  if (!prev) return { verdict: "pin", pin: cp, alerts };

  if (cp.height === prev.height) {
    if (cp.blockHash === prev.blockHash && cp.stateRoot === prev.stateRoot) {
      return { verdict: "same", pin: prev, alerts };
    }
    alerts.push(
      `fork detected at height ${cp.height}: pinned ${prev.blockHash.slice(0, 12)}… ` +
      `but node served ${cp.blockHash.slice(0, 12)}… (state ${prev.stateRoot.slice(0, 12)}… vs ${cp.stateRoot.slice(0, 12)}…)`,
    );
    return { verdict: "fork", pin: prev, alerts };
  }

  if (cp.height < prev.height) {
    const depth = prev.height - cp.height;
    alerts.push(`rollback detected: pinned height ${prev.height}, node served ${cp.height} (−${depth} blocks)`);
    if (depth >= retention) alerts.push(`rollback depth ${depth} ≥ retention ${retention}: node may have pruned or forked long ago`);
    return { verdict: "rollback", pin: prev, alerts, rollbackDepth: depth };
  }

  // forward progress
  if (cp.height - prev.height > retention) {
    alerts.push(
      `large gap: ${prev.height} → ${cp.height} exceeds checkpoint retention ${retention}; ` +
      `chain continuity must be proven with headers from the pinned blockHash`,
    );
  }
  return { verdict: "advance", pin: cp, alerts };
}

/** Keep the stronger of two anchors (never move backwards on our side). */
export function strongerPin(a: PinAnchor | null, b: PinAnchor | null): PinAnchor | null {
  if (!a) return b;
  if (!b) return a;
  return b.height > a.height ? b : a;
}
