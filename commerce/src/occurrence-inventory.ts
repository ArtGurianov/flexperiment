import type Database from "better-sqlite3";

export type SeatCommitments = {
  readonly sold: number;
  readonly held: number;
  readonly reconciling: number;
};

export type OccurrenceInventory = SeatCommitments & {
  readonly capacity: number;
  readonly adminReservedSeats: number;
  readonly customerCommitted: number;
  readonly committed: number;
  readonly available: number;
};

export type InventoryTarget = {
  readonly capacity: number;
  readonly adminReservedSeats: number;
};

export type InventoryTargetErrorCode = "CAPACITY_BELOW_COMMITTED_SEATS" | "RESERVE_EXCEEDS_AVAILABLE_CAPACITY";

export class InventoryTargetError extends Error {
  constructor(readonly code: InventoryTargetErrorCode, readonly details: Record<string, unknown>) {
    super(code);
  }
}

type InventoryRow = { capacity?: unknown; admin_reserved_seats?: unknown };

/**
 * The allocation predicate is deliberately centralized. It is used in read
 * queries, whereas the richer commitment partition is used by operator reads
 * and target-state validation.
 */
export const availableSeatsSql = (alias: string) =>
  `(${alias}.capacity - ${alias}.admin_reserved_seats - (SELECT COUNT(*) FROM bookings b WHERE b.occurrence_id = ${alias}.id AND b.status IN ('RESERVED', 'CONFIRMED')))`;

export const seatCommitments = (db: Database.Database, occurrenceId: string): SeatCommitments => {
  const row = db.prepare(`SELECT
    COUNT(*) FILTER (WHERE b.status = 'CONFIRMED') AS sold,
    COUNT(*) FILTER (WHERE b.status = 'RESERVED') AS reserved,
    COUNT(*) FILTER (WHERE b.status = 'RESERVED' AND (p.state = 'CREATE_UNKNOWN' OR p.status IN ('RECONCILING', 'REVIEW_REQUIRED'))) AS reconciling
    FROM bookings b
    LEFT JOIN payments p ON p.order_id = b.order_id
    WHERE b.occurrence_id = ?`).get(occurrenceId) as { sold: number; reserved: number; reconciling: number };
  return { sold: Number(row.sold), held: Number(row.reserved) - Number(row.reconciling), reconciling: Number(row.reconciling) };
};

export const occurrenceInventory = (db: Database.Database, occurrence: InventoryRow & { id: string }): OccurrenceInventory => {
  const commitments = seatCommitments(db, occurrence.id);
  const capacity = Number(occurrence.capacity);
  const adminReservedSeats = Number(occurrence.admin_reserved_seats ?? 0);
  const customerCommitted = commitments.sold + commitments.held + commitments.reconciling;
  const committed = customerCommitted + adminReservedSeats;
  return { ...commitments, capacity, adminReservedSeats, customerCommitted, committed, available: capacity - committed };
};

export const resolveInventoryTarget = (current: InventoryRow, patch: Record<string, unknown>): InventoryTarget => ({
  capacity: patch.capacity === undefined ? Number(current.capacity) : Number(patch.capacity),
  adminReservedSeats: patch.admin_reserved_seats === undefined ? Number(current.admin_reserved_seats ?? 0) : Number(patch.admin_reserved_seats),
});

export const assertInventoryTarget = (commitments: SeatCommitments, target: InventoryTarget): void => {
  const customerCommitted = commitments.sold + commitments.held + commitments.reconciling;
  const breakdown = { sold: commitments.sold, held: commitments.held, reconciling: commitments.reconciling, admin_reserved: target.adminReservedSeats };
  if (target.capacity < customerCommitted) {
    throw new InventoryTargetError("CAPACITY_BELOW_COMMITTED_SEATS", {
      requested_capacity: target.capacity, minimum_capacity: customerCommitted, breakdown,
    });
  }
  const committed = customerCommitted + target.adminReservedSeats;
  if (target.capacity < committed) {
    throw new InventoryTargetError("RESERVE_EXCEEDS_AVAILABLE_CAPACITY", {
      requested_capacity: target.capacity, minimum_capacity: committed, breakdown,
    });
  }
};
