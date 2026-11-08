# Light Client, State Proofs, Header Sync & Nullifiers (v1.15)

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
| 5. Nullifier | «не потрачено» по `nullifierRoot` из checkpoint | клиент сам | v1.14 |
| 6. Pinning | откат/форк истории относительно закреплённого якоря | клиент сам | v1.14 |
| 7. Wallet | баланс кошелька доказан целиком: checkpoint + headers + proof, ML-DSA в браузере | кошелёк сам | v1.15 |

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

## 5. Nullifier: «потрачено / не потрачено» без полного узла (v1.14)

Офлайн-платёж в mesh несёт `nullifier = H(ключ ‖ nonce)`. Получатель офлайн не может
спросить сеть, потрачен ли он, но может проверить это по **подписанному checkpoint**.

Дерево nullifier'ов:

```
leaf = "nullifier:<hex в нижнем регистре>", листья отсортированы лексикографически
nullifierRoot = merkleRoot(leaves)          // пустое множество = sha256("aegis-nullifiers-empty/v1")
stateRoot включает лист "nullifiers:<nullifierRoot>"  // набор потрат связан с состоянием
checkpoint v2 подписывает и nullifierRoot            // якорь для офлайн-проверки
```

Proof:

- `inclusion` — nullifier в дереве ⇒ **потрачен** (платёж отклоняем);
- `non-inclusion` — два **соседних** листа `left < n < right` (или пустое дерево);
  проверка смежности `right.index = left.index + 1` обязательна, иначе можно
  «доказать» отсутствие того, что на самом деле лежит между листьями.

```ts
import { verifyNullifierProof } from "./core-ts/nullifiers.js";
const { proof } = await rpc("aeg_isNullifierSpent", [nullifier]);
const res = verifyNullifierProof(proof, checkpoint.nullifierRoot); // компарация с подписью!
// res.ok === true, res.spent === false → можно принимать офлайн-пакет
```

RPC: `aeg_isNullifierSpent [nullifier]` → `{ spent, proof, verified, anchor }`,
`aeg_getNullifierRoot` → текущий root. Explorer проверяет proof в браузере
(вкладка Light client → «Nullifier»), включая сравнение с root из checkpoint.

Границы: proof доказывает статус **на момент checkpoint**; трата, попавшая в сеть
после него, в proof не видна — поэтому для крупных сумм ждём свежий checkpoint
(или проверяем по headers + state после синка). Это стандартный trade-off
light-client'ов, а не скрытая дыра.

## 6. Pinning: откат и форк (v1.14)

Клиент запоминает последний **проверенный** checkpoint (`aegis.pin` в localStorage):

| Ситуация | Вердикт | Пин |
|---|---|---|
| первое обращение | `pin` | записан |
| та же высота, тот же `blockHash`/`stateRoot` | `same` | не меняется |
| выше | `advance` | обновлён |
| ниже | `rollback` | **не понижается**, показывается предупреждение |
| та же высота, другой `blockHash` | `fork` | **не перезаписывается** |

Модуль `core-ts/pinning.ts` (чистый) + зеркало в кошельке
(`wallet-mobile/src/lib/pin.ts`). Кошелёк при обновлении баланса сверяет
`aeg_checkpointLatest` с пином и показывает «узел показал другую историю» при
fork/rollback; explorer делает то же во вкладке Light client.

## 7. Кошелёк доказывает свой баланс сам (v1.15)

До v1.15 «обновить баланс» в кошельке означало `aeg_getBalance` — то есть доверие
узлу на слово. Теперь кнопка **«✓ проверить без доверия (checkpoint + PQ)»**
прогоняет весь стек проверок в браузере (`wallet-mobile/src/lib/light.ts`):

```
aeg_validatorSet      → карта edPublic → { mlPublicKeyB64, stake }
aeg_checkpointLatest  → verifyCheckpoint(): гибридные подписи + ≥2/3 стейка
aeg_getHeaders(N+1..) → verifyHeaders(): height/prevHash/пересчёт хеша,
                        гибридная подпись блока, VRF-пропозер для slot
aeg_getProof(addr)    → verifyMerkleProof() + proof.root === cp.stateRoot
```

Итог показывается списком: каждая проверка отдельной строкой (`✓`/`✗`),
плюс явное «ML-DSA-65 проверяется в кошельке (@noble/post-quantum), не узлом».

Правила, которые кошелёк соблюдает:

1. **Якорь** — `cp.blockHash` это хеш блока `cp.height`, поэтому заголовки
   запрашиваются с `cp.height + 1` и `expectedPrevHash = cp.blockHash`.
2. **Свежесть** — если `proof.root ≠ cp.stateRoot`, баланс помечается как
   **не подтверждённый** («состояние изменилось после checkpoint»), а не
   «наверное, верный». Заголовки при этом всё равно проверяются: непрерывность
   истории доказана даже когда состояние устарело.
3. **Кворум** — при недоборе 2/3 стейка баланс не принимается, даже если узел
   настаивает, что всё хорошо.
4. **Pinning** — пин из v1.14 сверяется отдельно; rollback/fork показывается
   как предупреждение и не перезаписывается.
5. **Ключи** — `lh.mlPublicKeyB64` из заголовка сверяется с ключом валидатора,
   иначе возможна подмена PQ-ключа при валидной Ed25519-подписи.

Криптография в браузере: `@noble/ed25519` + `@noble/post-quantum` (ML-DSA-65),
`noble` v2 требует явный sync SHA-512 — `wallet-mobile/src/lib/noble-setup.ts`
ставит `ed.etc.sha512Sync` до первого использования (без него
`getPublicKey/sign/verify` падают с «hashes.sha512Sync not set»).

Регрессионные тесты: `wallet-mobile/test/light.test.ts` (5) и
`wallet-mobile/test/compat.test.ts` (3). Второй пинит совместимость кошелька и ядра:
раньше кошелёк считал `hybrid = sha256(hex(edSig) ‖ base64(mlSig))` вместо
`sha256(base64(edSig) ‖ base64(mlSig))`, и **каждая** транзакция из кошелька
отклонялась узлом с `bad hybrid sig`. Теперь обе стороны проверяются
кросс-тестом, включая подделку поля `hybrid`.

### Доверие vs удобство

| Что проверяется | Без v1.15 | С v1.15 |
|---|---|---|
| Баланс | `aeg_getBalance` (слово узла) | Merkle proof против подписанного `stateRoot` |
| Подписи checkpoint | не проверялись в кошельке | Ed25519 + ML-DSA-65 локально |
| История | не проверялась | заголовки от якоря, VRF-пропозер |
| Устаревшее состояние | незаметно | честное «не подтверждено» |

## Полный поток «с нуля» (fresh light client)

```
1. aeg_checkpointLatest          → cp{height N, stateRoot R, blockHash H}
2. verifyCheckpoint(cp, view)    → ≥2/3 стейка (ключи из genesis / прошлого cp)
3. aeg_getHeaders(N, N+k)        → verifyHeaderChain(..., {expectedPrevHash:H})
4. aeg_getProof(addr)            → пересчитать root, сравнить с R
5. aeg_getTxProof(h, i)          → проверить против header.merkleRoot из шага 3
6. aeg_isNullifierSpent(n)       → verifyNullifierProof(proof, cp.nullifierRoot)
7. assessCheckpoint(pin, cp)     → rollback/fork? не принимать новую историю
```

Кошелёк делает шаги 1–4 как одну операцию `lightBalance(call, address)`.

Ни на одном шаге не требуется доверять полному узлу. Единственное начальное
допущение — набор валидаторов (genesis config) или ранее проверенный checkpoint.

## Границы, которые мы не прячем

- Proof доказывает состояние **на момент запроса**; для платежа нужен свежий proof
  (height в ответе) либо проверка по подписанному checkpoint.
- Узел может withhold'ить proof/checkpoint — клиент увидит таймаут и переключится
  на другого пира; это liveness-проблема, не safety.
- **Кошелёк проверяет ML-DSA-65 в браузере** (`@noble/post-quantum`), поэтому
  кнопка «проверить без доверия» — это настоящая PQ-проверка, а не декорация.
- **Explorer** проверяет Ed25519 и все хеши через WebCrypto, но ML-DSA-65 не
  проверяет (в UI это написано явно). Для полной PQ-проверки используйте кошелёк.
- Proof nullifier'а актуален на момент checkpoint: трата после него не видна,
  пока не получен новый checkpoint/headers (см. раздел 5).
