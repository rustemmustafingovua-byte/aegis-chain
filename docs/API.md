# AEGIS API — RPC и REST (v1.14)

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
| `aeg_gasPrice` | `[]` | baseFee, priorityFee, suggestedMaxFee, median (v1.12) |
| `aeg_feeHistory` | `[n]` | последние n сэмплов base fee |
| `aeg_getProof` | `[address]` | Merkle inclusion proof + verified (v1.12) |
| `aeg_passkeyRegister` | `[address, credId, clientDataJSON, attestationObject, hybridProof, mlPubB64, label?]` | привязка passkey (v1.12) |
| `aeg_passkeyInfo` | `[address]` | список credential'ов |
| `aeg_passkeyRevoke` | `[address, credId]` | отвязать credential |
| `aeg_getHeaders` | `[from, to]` | заголовки + гибридные подписи; окно ≤100 (v1.13) |
| `aeg_verifyHeaders` | `[headers, {prevHash?, height?}]` | узел проверяет батч; клиент обязан проверить сам (v1.13) |
| `aeg_getTxProof` | `[height, index]` | tx + Merkle proof + header + blockHash (v1.13) |
| `aeg_validatorSet` | `[]` | edPublic, publicKey, mlPublicKeyB64, stake, address (v1.13) |
| `aeg_checkpointLatest` | `[]` | `{ checkpoint, verification }` или `null` (v1.13) |
| `aeg_getCheckpoints` | `[from=0, limit=50]` | история checkpoints, limit ≤200 (v1.13) |
| `aeg_checkpointSign` | `[]` | admin: подписать свой checkpoint, персистится (v1.13) |
| `aeg_getNullifierRoot` | `[]` | `{ height, nullifierRoot }` (v1.14) |
| `aeg_isNullifierSpent` | `[nullifier]` | `{ spent, proof, verified, anchor }` — inclusion/non-inclusion (v1.14) |

Tx формат (см. `core-ts/ledger.ts` Tx): `from, to?, amount (bigint→string в JSON), fee, nonce, intent (обязательно), domain (обязательно), timestamp, sig{edSig,mlSig,hybrid}, mlPublicKeyB64, edPublicB64? (обязателен при первой трате — TOFU binding), nullifier?, data?` (`stake:|unstake:|unlock:|swap:|addliq:`).

`aeg_sendTx` params: `[tx]` или `[tx, assertion]`, где `assertion = {credentialId, clientDataJSON, authenticatorData, signature}` — обязателен, если у `tx.from` привязан passkey (v1.12). Challenge assertion'а = `sha256(txMessage)`.

Fee policy: `tx.fee >= chain.feeMarket.baseFee`, иначе ошибка с подсказкой `aeg_gasPrice`.

## Light client (v1.13)

```bash
# 1) якорь: подписанный чекпоинт
curl -s localhost:8899/api/rpc -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"aeg_checkpointLatest","params":[]}'
# → { checkpoint: { height, stateRoot, blockHash, signatures[] }, verification: { ok, signedBps, signers } }

# 2) заголовки от якоря (≤100 за раз)
curl -s localhost:8899/api/rpc -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"aeg_getHeaders","params":[100,115]}'

# 3) proof транзакции внутри блока
curl -s localhost:8899/api/rpc -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"aeg_getTxProof","params":[100,0]}'
# → { tx, proof, header, blockHash }
```

Nullifier (v1.14):

```bash
curl -s localhost:8899/api/rpc -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"aeg_isNullifierSpent","params":["<hex>"]}'
# → { spent:false, proof:{type:"non-inclusion", root, left, right}, verified:true,
#     anchor:{height, nullifierRoot} }   — сверяй proof.root с anchor.nullifierRoot
```

Полный поток проверки — `docs/LIGHT_CLIENT.md`. `GET /api/state` включает
`checkpoint: { height, stateRoot, nullifierRoot, signedBps, signers }` и `nullifierRoot`
для дашбордов.

## Ошибки

- HTTP 200 + JSON-RPC error `{code:-32000, message}` — валидация/ledger/chain отклонение
- HTTP 413 `{code:-32001, "body too large"}` — тело >1MB (защита от DoS)
- HTTP 500 при dispatch exception; HTTP 404 для неверных URL

## P2P

P2pMessage (`core-ts/p2p.ts`): `hello, new_block, new_tx, sync_request, sync_response, mesh_packet, ping, pong`.
Транспорты: TCP-lite `:3899` + libp2p Noise `:4899`. HELLO подписан Ed25519, scoring −100 ban, rate-limit 50 msg/s, msg cap 256KB, sync cap 100.
