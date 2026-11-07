# AEGIS Interchain — Lumen ↔ AEGIS HTLC (v1.7, дизайн)

## Цель
Без централизованного кастодиана: LMN (Lumen) ↔ AEGIS (Aegis) атомарный своп через хеш-лок.

## Флоу ( symmetric с BridgeVault )
1. **Initiator (AEGIS):** `h = H(secret)`, lock AEGIS на AEGIS chain (`secretHash=h`, timelock T1)
2. **Responder (Lumen):** видит Funded на AEGIS, lock LMN на Lumen chain с тем же `h`, timelock T2 < T1
3. **Claim:** initiator раскрывает secret на Lumen → получает LMN, responder видит secret на Lumen → клеймит AEGIS
4. **Refund:** если secret не раскрыт к T2, responder ревёрсит LMN; к T1 initiator ревёрсит AEGIS

## Почему работает
- Хеш-лок одинаков на обоих чеийнах (SHA-256 preimage, ML-DSA не нужен для HTLC)
- Таймлоки дают responder окно: initiator не может забрать оба без раскрытия
- AEGIS nullifier гарантирует: AEGIS-side claim один, двойная трата невозможна при мерже

## Статус
- Стейтмент-дизайн. Реализация: `core-ts/bridge.ts` (AEGIS side) + `lumen-chain` keeper HTLC mirror.
- Watcher уже есть: `keeper/bridge-watcher.ts` (Base Funded → AEGIS mint). Для Lumen — аналогичный watcher на peer gossip.

## See also
- `docs/MESH.md` — DTN relay тот же gossip protocol
- `docs/THREAT_MODEL.md` — Bridge theft митигация
