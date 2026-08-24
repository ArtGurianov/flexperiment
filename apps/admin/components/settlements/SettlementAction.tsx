"use client";

import { FormEvent, useState } from "react";
import { api, idempotencyKey } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { string } from "../../lib/values";
import { formatRubles, parseRublesToKopecks } from "../../../../lib/money";
import type { Row } from "../../lib/page";
import { ActionModal } from "../ui/ActionModal";
import { MoneyInput } from "../ui/MoneyInput";
import { Notice } from "../ui/Notice";

type SettlementActionKind = "PAYMENT_MADE" | "DOCUMENTS_COMPLETE" | "CANCEL_BEFORE_PAYMENT" | "RECOVERY";

const MUTATION_FOR: Record<SettlementActionKind, "settlement.paymentMade" | "settlement.documentsComplete" | "settlement.cancelBeforePayment" | "settlement.recovery"> = {
  PAYMENT_MADE: "settlement.paymentMade",
  DOCUMENTS_COMPLETE: "settlement.documentsComplete",
  CANCEL_BEFORE_PAYMENT: "settlement.cancelBeforePayment",
  RECOVERY: "settlement.recovery",
};

export function SettlementAction({ action, settlement, close, done }: { action: SettlementActionKind; settlement: Row; close: () => void; done: () => void }) {
  const [key] = useState(idempotencyKey);
  const [documentReference, setDocumentReference] = useState("");
  const [npdDate, setNpdDate] = useState("");
  const [reason, setReason] = useState("");
  const [recoveryAmount, setRecoveryAmount] = useState("");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [confirmationText, setConfirmationText] = useState("");
  const maxRecovery = Number(settlement.unrecovered_amount_kopecks ?? 0);

  const mutation = useAdminMutation(
    MUTATION_FOR[action],
    () => {
      const base = `/reward-settlements/${string(settlement.id)}`;
      const headers = { "Content-Type": "application/json", "Idempotency-Key": key };
      if (action === "PAYMENT_MADE") return api(`${base}/payment-made`, { method: "POST", headers, body: JSON.stringify({ confirmation_text: confirmationText }) });
      if (action === "DOCUMENTS_COMPLETE") return api(`${base}/documents-complete`, { method: "POST", headers, body: JSON.stringify({ document_reference: documentReference, npd_status_effective_on: npdDate || undefined }) });
      if (action === "CANCEL_BEFORE_PAYMENT") return api(`${base}/cancel-before-payment`, { method: "POST", headers, body: JSON.stringify({ confirmation_text: confirmationText, reason }) });
      const amountKopecks = parseRublesToKopecks(recoveryAmount);
      if (amountKopecks === null) throw new Error("Recovery amount was not validated.");
      return api(`${base}/recoveries`, { method: "POST", headers, body: JSON.stringify({ amount_recovered_kopecks: amountKopecks, recovered_at: new Date().toISOString(), method: string(settlement.method), evidence_reference: evidenceReference }) });
    },
    { context: () => ({ settlementId: string(settlement.id) }) },
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await mutation.mutateAsync(undefined);
      done();
    } catch {
      // error surfaced via mutation.error below
    }
  };

  const title = action === "PAYMENT_MADE" ? "Подтвердить перевод"
    : action === "DOCUMENTS_COMPLETE" ? "Подтвердить документы"
    : action === "CANCEL_BEFORE_PAYMENT" ? "Отменить до оплаты"
    : "Зафиксировать recovery";
  const recoveryKopecks = parseRublesToKopecks(recoveryAmount);
  const recoveryValid = recoveryKopecks !== null && recoveryKopecks > 0 && recoveryKopecks <= maxRecovery;
  const expectedConfirmation = action === "PAYMENT_MADE"
    ? "I confirm the money was transferred"
    : `NOT PAID ${string(settlement.id)}`;

  return (
    <ActionModal title={title} close={close}>
      <form className="form" onSubmit={submit}>
        {action === "PAYMENT_MADE" && <>
          <p>Подтверждает только состоявшийся ручной перевод. После команды settlement перейдёт в PENDING_DOCUMENT.</p>
          <label>Введите фразу: <code>{expectedConfirmation}</code><input value={confirmationText} onChange={(event) => setConfirmationText(event.target.value)} required /></label>
        </>}
        {action === "DOCUMENTS_COMPLETE" && (
          <>
            <label>Ссылка на документ<input value={documentReference} onChange={(event) => setDocumentReference(event.target.value)} required minLength={2} /></label>
            <label>Дата статуса НПД<input type="date" value={npdDate} onChange={(event) => setNpdDate(event.target.value)} /></label>
          </>
        )}
        {action === "CANCEL_BEFORE_PAYMENT" && (
          <>
            <p>Допустимо только при сильном подтверждении, что деньги не переводились. Это высвобождает reservation.</p>
            <label>Введите фразу: <code>{expectedConfirmation}</code><input value={confirmationText} onChange={(event) => setConfirmationText(event.target.value)} required /></label>
            <label>Причина<textarea value={reason} onChange={(event) => setReason(event.target.value)} required minLength={3} /></label>
          </>
        )}
        {action === "RECOVERY" && (
          <>
            <label>Сумма, ₽<MoneyInput value={recoveryAmount} onChange={setRecoveryAmount} maxKopecks={maxRecovery} required /></label>
            <p>Невозвращённый остаток: <strong>{formatRubles(maxRecovery)}</strong>.</p>
            <label>Evidence reference<input value={evidenceReference} onChange={(event) => setEvidenceReference(event.target.value)} required minLength={3} /></label>
          </>
        )}
        <Notice error={mutation.error?.code} />
        <button className={action === "CANCEL_BEFORE_PAYMENT" ? "danger" : "primary"} disabled={mutation.isPending || ((action === "PAYMENT_MADE" || action === "CANCEL_BEFORE_PAYMENT") && confirmationText !== expectedConfirmation) || (action === "RECOVERY" && !recoveryValid)}>{mutation.isPending ? "Сохраняем…" : "Подтвердить"}</button>
      </form>
    </ActionModal>
  );
}
