import { canonical, id, sha256 } from "../crypto";
import { DomainError, one } from "../domain";

type SettlementsHost = any;

export const addSettlementRecovery = (
  host: SettlementsHost,
  settlementId: string,
  input: { amount_recovered_kopecks: number; recovered_at: string; method: string; evidence_reference: string; note?: string },
  idempotencyKey: string,
) => {
  const create = () => {
    const settlement = one(host.db, "SELECT id, status, amount_kopecks FROM reward_settlements WHERE id = ?", settlementId);
    if (!settlement) throw new DomainError("SETTLEMENT_NOT_FOUND", 404);
    if (settlement.status !== "PENDING_DOCUMENT" && settlement.status !== "SETTLED") throw new DomainError("SETTLEMENT_RECOVERY_NOT_PAID", 409);
    const alreadyRecovered = Number(one(host.db, "SELECT COALESCE(SUM(amount_recovered_kopecks), 0) AS amount FROM settlement_recoveries WHERE settlement_id = ?", settlementId)?.amount ?? 0);
    const remainingRecoverable = Number(settlement.amount_kopecks) - alreadyRecovered;
    if (input.amount_recovered_kopecks > remainingRecoverable) throw new DomainError("SETTLEMENT_RECOVERY_EXCEEDS_REMAINING", 409);
    const recoveryId = id();
    host.db.prepare("INSERT INTO settlement_recoveries(id, settlement_id, amount_recovered_kopecks, recovered_at, method, evidence_reference, note) VALUES (?, ?, ?, ?, ?, ?, ?)").run(recoveryId, settlementId, input.amount_recovered_kopecks, input.recovered_at, input.method, input.evidence_reference, input.note ?? null);
    return one(host.db, "SELECT * FROM settlement_recoveries WHERE id = ?", recoveryId)!;
  };
  const keyHash = sha256(idempotencyKey); const payloadHash = sha256(canonical({ settlement_id: settlementId, ...input }));
  return host.settlementTransaction(() => {
    const replay = one(host.db, "SELECT canonical_request_hash, recovery_id FROM reward_settlement_command_idempotency WHERE command = 'RECOVERY' AND idempotency_key_hash = ?", keyHash);
    if (replay) {
      if (replay.canonical_request_hash !== payloadHash) throw new DomainError("IDEMPOTENCY_CONFLICT", 409);
      return one(host.db, "SELECT * FROM settlement_recoveries WHERE id = ?", replay.recovery_id)!;
    }
    if (!Number.isInteger(input.amount_recovered_kopecks) || input.amount_recovered_kopecks <= 0) throw new DomainError("SETTLEMENT_RECOVERY_AMOUNT_INVALID", 422);
    const recovery = create();
    host.db.prepare("INSERT INTO reward_settlement_command_idempotency(command, idempotency_key_hash, canonical_request_hash, settlement_id, recovery_id) VALUES ('RECOVERY', ?, ?, ?, ?)").run(keyHash, payloadHash, settlementId, recovery.id);
    return recovery;
  });
};
