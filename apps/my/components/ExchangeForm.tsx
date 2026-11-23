"use client";

import { useEffect, useRef, useState } from "react";

/** FLEX-121: posts the one-time code to the LMS in the body (never in a URL), right away. The visible
 * button is the no-JS path; "Отмена" closes the exchange and never restarts it. */
export default function ExchangeForm({ action, tx, code, cancelTo }: { action: string; tx: string; code: string; cancelTo: string }) {
  const form = useRef<HTMLFormElement>(null);
  const [cancelled, setCancelled] = useState(false);
  useEffect(() => { form.current?.requestSubmit(); }, []);

  async function cancel() {
    setCancelled(true);
    await fetch(`/v1/my/exchange/${tx}/cancel`, { method: "POST", credentials: "same-origin", cache: "no-store" }).catch(() => undefined);
    window.location.assign(cancelTo);
  }

  return (
    <form ref={form} method="post" action={action}>
      <input type="hidden" name="tx" value={tx} />
      <input type="hidden" name="code" value={cancelled ? "" : code} />
      <p>Возвращаем вас к уроку…</p>
      <button type="submit" disabled={cancelled}>Продолжить</button>
      <button type="button" onClick={() => void cancel()} disabled={cancelled}>Отмена</button>
    </form>
  );
}
