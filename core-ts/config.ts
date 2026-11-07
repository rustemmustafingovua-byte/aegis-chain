/**
 * AEGIS Config v1.10 — single source of env truth (production hardening)
 * Env vars (prefix AEGIS_):
 *   PORT, P2P_PORT, STATE_FILE, FAUCET, ADMIN_TOKEN, RPC_RATE_LIMIT, LOG_LEVEL
 */
import * as path from "node:path";

export type AegisConfig = {
  port: number;
  p2pPort: number;
  stateFile: string; // default ~/.local/state/aegis-chain.json
  faucetEnabled: boolean; // AEGIS_FAUCET=off disables
  adminToken: string | null; // AEGIS_ADMIN_TOKEN — required for faucet/slash/register/prune in prod
  rpcRateLimit: number; // req/s per IP (default 100)
  logLevel: "debug" | "info" | "warn" | "error";
  libp2pPort: number; // libp2p listen = p2pPort + 1000
};

export function loadConfig(overrides: Partial<AegisConfig> = {}): AegisConfig {
  const env = process.env;
  const port = overrides.port ?? Number(env.PORT ?? env.AEGIS_PORT ?? 8899);
  const p2pPort = overrides.p2pPort ?? Number(env.P2P_PORT ?? env.AEGIS_P2P_PORT ?? 3899);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("bad PORT");
  if (!Number.isInteger(p2pPort) || p2pPort < 1 || p2pPort > 65535) throw new Error("bad P2P_PORT");
  const home = env.HOME ?? process.env.HOME ?? ".";
  const stateFile = overrides.stateFile ?? env.AEGIS_STATE_FILE ?? env.STATE_FILE ?? path.join(home, ".local/state/aegis-chain.json");
  const faucetEnabled = overrides.faucetEnabled ?? (env.AEGIS_FAUCET !== "off");
  const adminToken = overrides.adminToken ?? env.AEGIS_ADMIN_TOKEN ?? null;
  const rpcRateLimit = overrides.rpcRateLimit ?? Number(env.AEGIS_RPC_RATE_LIMIT ?? 100);
  const logLevel = (overrides.logLevel ?? ((env.AEGIS_LOG_LEVEL ?? "info") as AegisConfig["logLevel"]));
  if (!["debug", "info", "warn", "error"].includes(logLevel)) throw new Error("bad LOG_LEVEL");
  if (!Number.isInteger(rpcRateLimit) || rpcRateLimit < 1 || rpcRateLimit > 10000) throw new Error("bad RPC_RATE_LIMIT");
  return { port, p2pPort, stateFile, faucetEnabled, adminToken, rpcRateLimit, logLevel, libp2pPort: p2pPort + 1000 };
}

export const CONFIG = loadConfig();
