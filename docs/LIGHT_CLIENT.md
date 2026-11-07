# Light Client & State Proofs (v1.12)

## Проблема доверия

Кошелёк, который спрашивает у узла «сколько у меня денег», доверяет узлу на слово.
Для trust layer это неприемлемо: узел (или MITM) может соврать о балансе, и пользователь
подпишет платёж, которого не может себе позволить.

v1.12 добавляет **Merkle-обязательство состояния** и **inclusion proofs**:

```
stateRoot = MerkleRoot(sorted leaves)
leaf      = "account:<addr>:<balance>:<stake>:<nonce>:<pendingUnstake>"
```

Дерево доменно-разделено (`H(0x00||leaf)` для листьев, `H(0x01||l||r)` для узлов),
поэтому лист нельзя выдать за внутренний узел (second-preimage).

## Что умеет клиент

1. `aeg_getState` → `stateRoot` (32 байта).
2. `aeg_getProof [address]` → `{ leaf, index, total, siblings[], root, height, verified }`.
3. Клиент **сам** пересчитывает root из листа и siblings и сравнивает с `stateRoot`,
   который он получил из другого источника (например, из gossip-блока или checkpoint-подписи).

Explorer делает это прямо в браузере: кнопка **«🔐 доказать (light client)»** пересчитывает
Merkle-путь через WebCrypto и показывает ✓/✗ — без доверия узлу.

## API

```ts
import { verifyMerkleProof } from "./core-ts/merkle.js";
const proof = await rpc("aeg_getProof", [address]);
verifyMerkleProof(proof); // true | false
```

## Почему не полный SPV

- Блок-хедеры подписаны гибридно (Ed25519 + ML-DSA-65), поэтому лёгкий клиент может
  проверять цепочку хедеров без тел блоков (заголовок содержит `merkleRoot` транзакций).
- v1.12 даёт proof для **состояния**; v1.13 — синхронизация хедеров с checkpoint-подписями
  валидаторов и доказательство невключения (non-inclusion) для nullifier'ов.

## Границы

- Proof доказывает состояние **на момент запроса**; для платежа нужен свежий proof
  (height в ответе) либо проверка по подписанному checkpoint.
- Узел может withhold'ить proof — клиент увидит таймаут и переключится на другого пира.
