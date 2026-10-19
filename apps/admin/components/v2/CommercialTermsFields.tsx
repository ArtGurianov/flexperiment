"use client";

import { useId } from "react";
import type { SaleMode } from "../../lib/control-room-contracts";

/** The commercial terms both the course and the LAB editor send; identity stays with each editor (ART-341). */
export type CommercialTermsDraft = {
  price: string;
  saleMode: SaleMode;
  paymentPurpose: string;
  allowlist: string;
};

export const commercialTermsDraft = (offer: {
  priceKopecks: number; saleMode: SaleMode; paymentPurpose: string | null; acceptanceAllowlist: string[];
} | null | undefined): CommercialTermsDraft => ({
  price: String(offer?.priceKopecks ?? 0),
  saleMode: offer?.saleMode ?? "CLOSED",
  paymentPurpose: offer?.paymentPurpose ?? "",
  allowlist: offer?.acceptanceAllowlist.join("\n") ?? "",
});

export const commercialTermsCommand = (draft: CommercialTermsDraft) => ({
  priceKopecks: Number(draft.price),
  saleMode: draft.saleMode,
  paymentPurpose: draft.paymentPurpose || null,
  acceptanceAllowlist: draft.allowlist.split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
});

/** Price is `offers.price_kopecks`, the one current price: a change applies to new quotes only. */
export function CommercialTermsFields({ value, onChange, paid }: {
  value: CommercialTermsDraft; onChange: (next: CommercialTermsDraft) => void; paid: boolean;
}) {
  const priceScopeId = useId();
  const set = <K extends keyof CommercialTermsDraft>(key: K, next: CommercialTermsDraft[K]) => onChange({ ...value, [key]: next });
  return <>
    <label>Цена, коп.<input required inputMode="numeric" aria-describedby={priceScopeId} value={value.price}
      onChange={(event) => set("price", event.target.value)} /></label>
    <small id={priceScopeId}>Новая цена действует для новых расчётов; выданная цена и оплаченные заказы не меняются.</small>
    <label>Режим продажи<select value={value.saleMode} onChange={(event) => set("saleMode", event.target.value as SaleMode)}>
      <option value="CLOSED">CLOSED</option><option value="ACCEPTANCE_ONLY">ACCEPTANCE_ONLY</option><option value="PUBLIC">PUBLIC</option>
    </select></label>
    <label>Назначение платежа<textarea value={value.paymentPurpose} maxLength={512}
      required={paid && value.saleMode !== "CLOSED"} onChange={(event) => set("paymentPurpose", event.target.value)} />
      <small>Назначение заказа, не название позиции чека. Без сокращения; лимит Точки 140 UTF-16 units.</small></label>
    {value.saleMode === "ACCEPTANCE_ONLY" ? <label>Allowlist<textarea value={value.allowlist}
      onChange={(event) => set("allowlist", event.target.value)} placeholder="buyer@example.ru" /></label> : null}
  </>;
}
