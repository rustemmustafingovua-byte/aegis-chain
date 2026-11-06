"""
AEGIS Mesh — автономная p2p сеть без интернета.

Протокол:
  - Пакет = подписанная транзакция + метаданные gossip (ttl, hops, priority)
  - Транспорты: QR (~500B) / BLE (185B chunks) / WiFi Direct / LoRa (51-242B) / sneakernet (USB)
  - Маршрутизация: epidemic gossip + store-carry-forward (DTN)
  - Дедупликация: по tx_hash + nullifier
  - Anti-spam: rate limit per human_context, proof-of-humanity ticket

Классы:
  - MeshPacket: обёртка для любого транспорта
  - MeshNode: узел с кошельком, mempool, ledger snapshot, очередью
"""
import hashlib
import json
import os
import time

def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()

# ---------- Packet ----------

def make_packet(tx: dict, priority: str = "normal", ttl: int = 8) -> dict:
    return {
        "type": "AEGIS_PACKET",
        "v": "0.2",
        "tx": tx,
        "tx_hash": tx["tx_hash"],
        "nullifier": tx["nullifier"],
        "hops": 0,
        "ttl": ttl,
        "priority": priority,
        "origin": tx.get("from"),
        "created_at": int(time.time()),
    }

def packet_encode(packet: dict) -> bytes:
    """Сериализация для QR/BLE: json + zlib-style compact (тут просто json bytes).
    В проде: msgpack + fragmentation для BLE/LoRa."""
    return json.dumps(packet, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()

def packet_decode(data: bytes) -> dict:
    return json.loads(data.decode())

def packet_size(packet: dict) -> int:
    return len(packet_encode(packet))

# ---------- Mesh Node ----------

class MeshNode:
    def __init__(self, node_id: str, wallet):
        self.node_id = node_id
        self.wallet = wallet
        self.mempool = {}          # tx_hash -> tx
        self.seen_nullifiers = set()
        self.peers = set()         # node_ids
        self.offline_queue = []    # store-carry-forward: пакеты, которые ждём передать
        self.ledger_snapshot = {
            "height": 0,
            "balances": {},  # addr -> balance at last sync
            "hash": sha256_hex("genesis")[:16],
        }
        self.balance = 1000  # в проде: из локального ledger
        self.seq = 0
        self.online = False
        self.stats = {"received": 0, "forwarded": 0, "dedup": 0, "conflicts": 0}

    def connect(self, peer: "MeshNode"):
        self.peers.add(peer.node_id)
        peer.peers.add(self.node_id)

    def disconnect(self, peer: "MeshNode"):
        self.peers.discard(peer.node_id)
        peer.peers.discard(self.node_id)

    def receive(self, packet: dict) -> str:
        """Принимает пакет от пира. Возвращает статус."""
        tx = packet["tx"]
        tx_hash = packet["tx_hash"]
        nullifier = packet["nullifier"]

        if tx_hash in self.mempool:
            self.stats["dedup"] += 1
            return "dedup: tx already seen"

        if nullifier in self.seen_nullifiers:
            self.stats["conflicts"] += 1
            return "conflict: nullifier already spent (double-spend candidate)"

        # basic validation (в проде: verify_tx + verify_offline)
        if tx.get("amount", 0) <= 0:
            return "rejected: bad amount"
        if tx.get("expiry", 0) < int(time.time()):
            return "rejected: expired"

        # TODO: в проде здесь вызывается полное verify из autonomy.py

        self.mempool[tx_hash] = tx
        self.seen_nullifiers.add(nullifier)
        self.stats["received"] += 1
        # обновлённая локальная snapshot-баланс (optimistic)
        return "accepted: added to mempool"

    def epidemic_gossip(self, nodes: dict):
        """Один раунд epidemic gossip: разослать все пакеты пирам.
        Возвращает список (from, to, status) для визуализации."""
        log = []
        for node_id in list(self.peers):
            peer = nodes.get(node_id)
            if not peer:
                continue
            for tx_hash, tx in list(self.mempool.items()):
                packet = make_packet(tx)
                packet["hops"] = 1
                status = peer.receive(packet)
                self.stats["forwarded"] += 1
                log.append((self.node_id, peer.node_id, status))
        return log

    def queue_for_carry(self, packet: dict):
        self.offline_queue.append(packet)

    def flush_carry(self, nodes: dict):
        """Store-carry-forward: при встрече с пиром отдаём очередь."""
        flushed = 0
        remaining = []
        for packet in self.offline_queue:
            delivered = False
            for node_id in list(self.peers):
                peer = nodes.get(node_id)
                if peer and peer.receive(packet) in ("accepted: added to mempool", "dedup: tx already seen"):
                    flushed += 1
                    delivered = True
                    break
            if not delivered:
                remaining.append(packet)
        self.offline_queue = remaining
        return flushed

    def sign_offline(self, to, amount, intent, domain, local_entropy):
        from .autonomy import offline_sign
        tx = offline_sign(
            self.wallet.private_key,
            self.wallet.address,
            to, amount, intent, domain,
            local_entropy,
            height_at_sync=self.ledger_snapshot["height"],
            balance_proof_hash=self.ledger_snapshot["hash"],
            seq=self.seq,
        )
        self.seq += 1
        # свой пакет сразу в mempool
        self.mempool[tx["tx_hash"]] = tx
        self.seen_nullifiers.add(tx["nullifier"])
        return tx

    def sync_online(self, global_ledger: dict):
        """Интернет-синхронизация: отправляем mempool в глобальный ledger,
        получаем свежий height + balances snapshot."""
        accepted = 0
        for tx_hash, tx in list(self.mempool.items()):
            nullifier = tx["nullifier"]
            if nullifier in global_ledger.get("spent_nullifiers", set()):
                # double-spend!
                self.stats["conflicts"] += 1
                continue
            global_ledger.setdefault("spent_nullifiers", set()).add(nullifier)
            global_ledger.setdefault("txs", {})[tx_hash] = tx
            accepted += 1
        # обновляем snapshot
        global_ledger["height"] = global_ledger.get("height", 0) + accepted
        self.ledger_snapshot["height"] = global_ledger["height"]
        self.ledger_snapshot["hash"] = sha256_hex(str(global_ledger["height"]))[:16]
        self.online = True
        return accepted

# ---------- Network simulation helpers ----------

def simulate_line_topology(node_ids: list) -> dict:
    """Линия A-B-C-D-E: A связан с B, B с C и т.д."""
    nodes = {}  # заполняется снаружи
    return nodes
