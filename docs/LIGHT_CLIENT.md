# Light Client, State Proofs & Header Sync (v1.13)

## Проблема доверия

Кошелёк, который спрашивает у узла «сколько у меня денег», доверяет узлу на слово.
Для trust layer это неприемлемо: узел (или MITM) может соврать о балансе, и пользователь
подпишет платёж, которого не может себе позволить.

Лестница доверия, которую строит AEGIS:

| Уровень | Что доказывается | Кто проверяет | Версия |
|---|---|---|---|
| 1. State proof | баланс входит в `stateRoot` | клиент сам | v1.12 |
| 2. Tx proof | транзакция входит в `header.merkleRoot` | клиент сам | v1.13 |
| 3. Header sync | цепочка заголовков от якоря | клиент сам | v1.13 |
| 4. Checkpoint | `stateRoot` подписан ≥2/3 стейка | клиент сам | v1.13 |

## 1. Merkle-обязательство состояния (v1.12)

```
stateRoot = MerkleRoot(sorted leaves)
leaf      = "account:<addr>:<balance>:<stake>:<nonce>:<pendingUnstake>"
```

Дерево доменно-разделено (`H(0x00||leaf)` для листьев, `H(0x01||l||r)` для узлов),
поэтому лист нельзя выдать за внутренний узел (second-preimage).

1. `aeg_getState` → `stateRoot`.
2. `aeg_getProof [address]` → `{ leaf, index, total, siblings[], root, height, verified }`.
3. Клиент **сам** пересчитывает root из листа и siblings и сравнивает с `stateRoot`
   из независимого источника (подписанный checkpoint или gossip-блок).

```ts
import { verifyMerkleProof } from "./core-ts/merkle.js";
const proof = await rpc("aeg_getProof", [address]);
verifyMerkleProof(proof); // true | false
```

Explorer: вкладка **Light client** и кнопка **«🔐 доказать (light client)»** пересчитывают
Merkle-путь через WebCrypto прямо в браузере.

## 2. Signed checkpoints (v1.13)

Checkpoint — обязательство валидаторов за состояние на высоте N:

```ts
type Checkpoint = {
  height: number;
  stateRoot: string;   // Merkle-root состояния
  blockHash: string;   // хеш заголовка блока N (якорь для header sync)
  timestamp: number;
  signatures: { validator: string; sig: HybridSignature }[]; // Ed25519 + ML-DSA-65
};
```

Подписывается сообщение `"aegis-checkpoint/v1|height|stateRoot|blockHash|timestamp"`.
Правило финальности то же, что у блоков: **≥ 2/3 стейка** (6667 bps, округление до
ближайшего базис-пункта). `verifyCheckpoint` возвращает `signedBps`, `totalStake`,
`signers` и `reason`, чтобы UI мог показать, чего не хватает.

```ts
import { verifyCheckpoint, checkpointMessage } from "./core-ts/checkpoints.js";
const { checkpoint } = await rpc("aeg_checkpointLatest");
const v = verifyCheckpoint(checkpoint, trustedValidatorView, 6667);
if (!v.ok) throw new Error(v.reason);
```

- Узел публикует checkpoint каждые 10 блоков (`server.ts`) и хранит последние 256
  (`CheckpointStore`, файл `aegis-chain-checkpoints.json`).
- `aeg_checkpointLatest` → `{ checkpoint, verification }`.
- `aeg_getCheckpoints [from, limit]` → история.
- `aeg_checkpointSign` (admin) → узел подписывает свой checkpoint вручную; в мульти-
  валидаторной сети каждый узел добавляет свою подпись, store мёржит по `height`.

## 3. Header sync (v1.13)

`core-ts/headers.ts` проверяет пачку заголовков без тел блоков:

1. высоты идут подряд, `prevHash` связан hash-to-hash;
2. `headerHash` пересчитывается и совпадает с заявленным `hash`;
3. `proposer` — известный валидатор, и гибридная подпись (Ed25519 + ML-DSA-65) над
   хешем заголовка валидна;
4. `proposer` совпадает со stake-weighted VRF для слота (та же функция, что в
   `Chain.proposerForSlot`, считается только из `prevHash`);
5. опциональный якорь: `expectedPrevHash` (blockHash чекпоинта) и `expectedHeight`.

```ts
import { verifyHeaderChain, validatorViewOf } from "./core-ts/headers.js";
const headers = await rpc("aeg_getHeaders", [cp.height, cp.height + 20]);
const res = verifyHeaderChain(headers, view, {
  expectedPrevHash: cp.blockHash,
  expectedHeight: cp.height,
});
if (!res.ok) throw new Error(res.reason);
```

`aeg_validatorSet` отдаёт набор валидаторов (Ed25519 public key, ML-DSA public key,
stake, address) — именно то, что нужно клиенту для проверки.

## 4. Tx inclusion proof (v1.13)

`aeg_getTxProof [height, index]` → `{ tx, proof, header, blockHash }`, где `proof.root`
обязан равняться `header.merkleRoot` (узел падает с ошибкой, если блок повреждён).

```ts
import { verifyMerkleProof } from "./core-ts/merkle.js";
const { proof, header } = await rpc("aeg_getTxProof", [height, index]);
assert.equal(proof.root, header.merkleRoot);
assert.equal(verifyMerkleProof(proof), true);
```

## Полный поток «с нуля» (fresh light client)

```
1. aeg_checkpointLatest          → cp{height N, stateRoot R, blockHash H}
2. verifyCheckpoint(cp, view)    → ≥2/3 стейка (ключи из genesis / прошлого cp)
3. aeg_getHeaders(N, N+k)        → verifyHeaderChain(..., {expectedPrevHash:H})
4. aeg_getProof(addr)            → пересчитать root, сравнить с R
5. aeg_getTxProof(h, i)          → проверить против header.merkleRoot из шага 3
```

Ни на одном шаге не требуется доверять полному узлу. Единственное начальное
допущение — набор валидаторов (genesis config) или ранее проверенный checkpoint.

## Границы, которые мы не прячем

- Proof доказывает состояние **на момент запроса**; для платежа нужен свежий proof
  (height в ответе) либо проверка по подписанному checkpoint.
- Узел может withhold'ить proof/checkpoint — клиент увидит таймаут и переключится
  на другого пира; это liveness-проблема, не safety.
- Браузерный explorer проверяет **Ed25519 и все хеши** через WebCrypto. ML-DSA-65
  в браузере пока не проверяется (нет нативного API, WASM-сборка `@noble/post-quantum`
  в планах) — в UI это написано явно, а не замаскировано.
- Non-inclusion proofs для nullifier'ов (доказать, что офлайн-трата ещё не потрачена)
  — следующий шаг, см. `docs/ROADMAP.md`.
