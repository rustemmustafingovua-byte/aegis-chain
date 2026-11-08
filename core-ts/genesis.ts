/**
 * AEGIS Genesis v1.16 — общий набор валидаторов для нескольких узлов.
 *
 * Один devnet-узел удобен, но «сеть из одного процесса» ничего не доказывает
 * про устойчивость. Чтобы запустить 3 узла, у них должен совпадать генезис:
 * одинаковый список валидаторов, стейк и балансы, применённые в одном и том же
 * порядке. Иначе состояние (stateRoot) разъедется на первом же блоке.
 *
 * Формат файла (AEGIS_GENESIS_VALIDATORS=/path/genesis.json):
 *
 *   { "validators": [
 *       { "edPublic": "<base64>", "mlPublicKeyB64": "<base64>", "stake": "10000000000",
 *         "address": "aeg1…", "balance": "100000000000", "humanityScore": 90 }
 *   ] }
 *
 * Порядок применения всегда сортируется по edPublic, поэтому два узла,
 * читающие один файл, получают байт-в-байт одинаковый ledger.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Chain } from "./chain.js";

export type GenesisValidator = {
  edPublic: string;
  mlPublicKeyB64: string;
  stake: string;
  address?: string;
  balance?: string;
  humanityScore?: number;
};

export type GenesisConfig = { validators: GenesisValidator[] };

function expand(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Принимает путь к файлу ИЛИ inline JSON (удобно в тестах и systemd unit). */
export function readGenesisConfig(source: string): GenesisConfig {
  const raw = source.trim();
  const text = raw.startsWith("{") || raw.startsWith("[")
    ? raw
    : fs.readFileSync(expand(raw), "utf8");
  const parsed = JSON.parse(text);
  const list: any[] = Array.isArray(parsed) ? parsed : parsed.validators;
  if (!Array.isArray(list)) throw new Error("genesis: validators[] is required");
  const validators = list.map((v, i) => {
    if (!v?.edPublic || !v?.mlPublicKeyB64) throw new Error(`genesis: validator #${i} missing keys`);
    if (v.stake === undefined) throw new Error(`genesis: validator #${i} missing stake`);
    return {
      edPublic: String(v.edPublic),
      mlPublicKeyB64: String(v.mlPublicKeyB64),
      stake: String(v.stake),
      address: v.address ? String(v.address) : undefined,
      balance: v.balance !== undefined ? String(v.balance) : undefined,
      humanityScore: typeof v.humanityScore === "number" ? v.humanityScore : undefined,
    } satisfies GenesisValidator;
  });
  return { validators };
}

/** Env helper: AEGIS_GENESIS_VALIDATORS (path or inline JSON), empty = single-node devnet. */
export function genesisFromEnv(env: NodeJS.ProcessEnv = process.env): GenesisConfig | null {
  const src = env.AEGIS_GENESIS_VALIDATORS;
  if (!src) return null;
  return readGenesisConfig(src);
}

export type ApplyResult = { applied: number; funded: number; already: number };

/**
 * Применяет генезис-конфиг к цепи.
 *
 * `fresh` = цепь только что создана (height 0): балансы начисляются.
 * На восстанавливаемой цепи балансы НЕ трогаем (иначе двойное начисление),
 * только досоздаём отсутствующие записи валидаторов — идемпотентно.
 */
export function applyGenesisConfig(chain: Chain, cfg: GenesisConfig, opts: { fresh: boolean } = { fresh: true }): ApplyResult {
  const res: ApplyResult = { applied: 0, funded: 0, already: 0 };
  const sorted = [...cfg.validators].sort((a, b) => (a.edPublic < b.edPublic ? -1 : a.edPublic > b.edPublic ? 1 : 0));
  for (const v of sorted) {
    if (chain.validators.has(v.edPublic)) {
      res.already++;
      continue;
    }
    chain.addValidator(v.edPublic, v.mlPublicKeyB64, BigInt(v.stake), v.address);
    res.applied++;
    if (v.address) {
      const acct = chain.ledger.get(v.address);
      if (!acct.edPublic) acct.edPublic = v.edPublic;
      if (v.humanityScore !== undefined) acct.humanityScore = v.humanityScore;
      else if (acct.humanityScore === undefined || acct.humanityScore === 0) acct.humanityScore = 90;
      if (opts.fresh && v.balance !== undefined && acct.balance === 0n) {
        chain.ledger.fund(v.address, BigInt(v.balance));
        res.funded++;
      }
    }
  }
  return res;
}
