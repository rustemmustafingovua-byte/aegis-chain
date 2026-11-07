# AEGIS API — RPC и REST (v1.0)

База: `POST /api/rpc` (JSON-RPC 2.0), `GET /api/state`, `GET /health`, `/` — explorer static.

## Health / State

```bash
curl http://127.0.0.1:8899/health        # {"ok":true,"height":N,"version":"1.0.0"}
curl http://127.0.0.1:8899/api/state     # height, head, mempool, supply, stateRoot, validators, accounts, pools, proposals, peers, blocks[-20]
curl http://127.0.0.1:8899/api/rpc -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"aeg_getState","params":[]}'
```

## Методы RPC

| Метод | Params | Результат |
|---|---|---|
| `aeg_getState` | `[]` | height, head, supply, stateRoot |
| `aeg_getBlock` | `[height]` | block JSON (header+txs+hybrid sig) |
| `aeg_getBlocks` | `[limit=20]` | последние блоки |
| `aeg_getBalance` | `[address]` | balance base-units (string) |
| `aeg_getAccount` | `[address]` | balance, stake, nonce, humanityScore, pendingUnstake |
| `aeg_sendTx` | `[tx]` | canApply → mempool → gossip. Tx см. ledger Tx |
| `aeg_swapQuote` | `[poolKey, amount]` | amountOut (AMM quote, 0.30% fee) |
| `aeg_poolInfo` | `[key?]` | base, quote, feeBps, totalShares |
| `aeg_govPropose` | `[id,title,action,proposer]` | created |
| `aeg_govVote` | `[id,voter,support]` | tally |
| `aeg_govList` | `[]` | proposals[] |
| `aeg_bridgeQuote` | `[usdcIn, base, quote]` | aegisOut |
| `aeg_validatorList` | `[]` | edPublic, stake, address |
| `aeg_peerList` | `[]` | p2p peers |
| `aeg_meshStatus` | `[]` | mesh mempool/peers/stats |
| `aeg_sync` | `[]` | height, blocks, stateRoot |

Tx формат (см. `core-ts/ledger.ts` Tx): `from, to?, amount (bigint→string в JSON), fee, nonce, intent (обязательно), domain (обязательно), timestamp, sig{edSig,mlSig,hybrid}, mlPublicKeyB64, nullifier?, data?` (`stake:|unstake:|unlock:|swap:|addliq:`).

## Ошибки

- HTTP 200 + JSON-RPC error `{code:-32000, message}` — валидация/ledger/chain отклонение
- HTTP 413 `{code:-32001, "body too large"}` — тело >1MB (защита от DoS)
- HTTP 500 при dispatch exception; HTTP 404 для неверных URL

## P2P

P2pMessage (`core-ts/p2p.ts`): `hello, new_block, new_tx, sync_request, sync_response, mesh_packet, ping, pong`.
Транспорты: TCP-lite `:3899` + libp2p Noise `:4899`. HELLO подписан Ed25519, scoring −100 ban, rate-limit 50 msg/s, msg cap 256KB, sync cap 100.
