import { openReadOnlyDatabase } from "./db";
import { gen1PostActivationEmailToGen2Bridge } from "./release-control";
import { parsePostActivationEmailProviderDefectEvidence, reconcileHeadWithProjection, releaseStateHash, replayReleaseGenerationChain, type V2Event } from "./release-generation";

const bridge = gen1PostActivationEmailToGen2Bridge;
const expectedStateHash = process.env.COMMERCE_GEN1_TO_GEN2_BRIDGE_RECEIPT_STATE_HASH;

if (!expectedStateHash || !/^[a-f0-9]{64}$/.test(expectedStateHash)) {
  throw new Error("GEN1_TO_GEN2_BRIDGE_RECEIPT_STATE_HASH_INVALID");
}

const db = openReadOnlyDatabase();
try {
  const events = db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC")
    .all(bridge.release_id) as V2Event[];
  const replay = replayReleaseGenerationChain(events);
  const head = replay.head;
  if (replay.corrupt || !head || head.release_id !== bridge.release_id || head.candidate_generation !== bridge.to_generation
    || head.source_commit !== bridge.to_source_commit || head.phase !== "PAUSED" || head.phase_sequence !== 0 || head.certification) {
    throw new Error("GEN1_TO_GEN2_BRIDGE_DURABLE_HEAD_INVALID");
  }

  const pair = events.slice(-2).map((entry) => {
    try { return JSON.parse(entry.details_json) as Record<string, unknown>; }
    catch { return null; }
  });
  const defect = pair[0]; const supersede = pair[1];
  const defectHead = defect?.head as Record<string, unknown> | undefined;
  const supersedeHead = supersede?.head as Record<string, unknown> | undefined;
  if (defect?.kind !== "POST_ACTIVATION_EMAIL_PROVIDER_DEFECT" || defect.from_phase !== "CERTIFIED" || defect.from_phase_sequence !== bridge.from_phase_sequence
    || !parsePostActivationEmailProviderDefectEvidence(defect.post_activation_email_provider_defect, bridge.from_source_commit)
    || defectHead?.candidate_generation !== bridge.from_generation || defectHead.source_commit !== bridge.from_source_commit
    || defectHead.phase !== "RECOVERY_REQUIRED" || defectHead.phase_sequence !== bridge.from_phase_sequence + 1
    || (defectHead?.certification as Record<string, unknown> | undefined)?.status !== "CONSUMED"
    || supersede?.kind !== "CANDIDATE_SUPERSEDED" || supersede.from_generation !== bridge.from_generation || supersede.from_sha !== bridge.from_source_commit
    || supersedeHead?.candidate_generation !== bridge.to_generation || supersedeHead.source_commit !== bridge.to_source_commit
    || supersedeHead.phase !== "PAUSED" || supersedeHead.phase_sequence !== 0 || "certification" in (supersedeHead ?? {})) {
    throw new Error("GEN1_TO_GEN2_BRIDGE_DURABLE_EVENT_PAIR_INVALID");
  }

  const gate = db.prepare(`SELECT sales_paused, owner_release_id, expected_source_commit, expected_migration,
    expected_legal_version, expected_legal_manifest_sha256 FROM release_sales_gate WHERE singleton = 1`).get() as {
      sales_paused: number; owner_release_id: string | null; expected_source_commit: string | null; expected_migration: string | null;
      expected_legal_version: string | null; expected_legal_manifest_sha256: string | null;
    } | undefined;
  if (!gate || gate.sales_paused !== 1 || gate.owner_release_id !== bridge.release_id || gate.expected_source_commit !== bridge.to_source_commit
    || reconcileHeadWithProjection(head, { owner_release_id: gate.owner_release_id, sales_paused: true,
      expected_source_commit: gate.expected_source_commit, expected_migration: gate.expected_migration,
      expected_legal_version: gate.expected_legal_version, expected_legal_manifest_sha256: gate.expected_legal_manifest_sha256 })) {
    throw new Error("GEN1_TO_GEN2_BRIDGE_DURABLE_GATE_INVALID");
  }

  const authority = db.prepare(`SELECT attempt_authority, email_dispatch_paused, dispatch_owner_release_id,
    dispatch_owner_generation, revision FROM outbox_authority WHERE singleton = 1`).get() as {
      attempt_authority: string; email_dispatch_paused: number; dispatch_owner_release_id: string | null;
      dispatch_owner_generation: number | null; revision: number;
    } | undefined;
  const drain = db.prepare(`SELECT
    (SELECT COUNT(*) FROM email_outbox WHERE status = 'SENDING') AS sending,
    (SELECT COUNT(*) FROM email_outbox WHERE lease_owner IS NOT NULL) +
    (SELECT COUNT(*) FROM outbox_attempt WHERE lease_owner IS NOT NULL) AS leased`).get() as { sending: number; leased: number };
  const lastAuthorityEvent = db.prepare(`SELECT action, owner_release_id, owner_generation, revision
    FROM outbox_authority_events ORDER BY revision DESC, rowid DESC LIMIT 1`).get() as {
      action: string; owner_release_id: string | null; owner_generation: number | null; revision: number;
    } | undefined;
  if (!authority || authority.attempt_authority !== "ATTEMPT" || authority.email_dispatch_paused !== 1
    || authority.dispatch_owner_release_id !== bridge.release_id || authority.dispatch_owner_generation !== null
    || authority.revision !== bridge.authority_revision || drain.sending !== 0 || drain.leased !== 0
    || lastAuthorityEvent?.action !== "DISPATCH_FENCED" || lastAuthorityEvent.owner_release_id !== bridge.release_id
    || lastAuthorityEvent.owner_generation !== null || lastAuthorityEvent.revision !== bridge.authority_revision) {
    throw new Error("GEN1_TO_GEN2_BRIDGE_DURABLE_AUTHORITY_INVALID");
  }

  const stateHash = releaseStateHash(head);
  if (stateHash !== expectedStateHash) throw new Error("GEN1_TO_GEN2_BRIDGE_RECEIPT_STATE_HASH_MISMATCH");
  console.log(JSON.stringify({ release_id: bridge.release_id, state_hash: stateHash, bridge_verified: true }));
} finally {
  db.close();
}
