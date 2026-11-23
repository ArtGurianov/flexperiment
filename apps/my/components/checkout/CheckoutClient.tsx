"use client";

/** FLEX-122: binds the checkout controller to the browser (sessionStorage, same-origin `/v1/*`). */
import { useEffect, useMemo, useState } from "react";
import { CheckoutController, type CheckoutState } from "./checkout-controller";
import { IntentStore } from "./intent-store";
import { CheckoutView } from "./CheckoutView";

export default function CheckoutClient({ intentId, offerRef, returnedOrder }: { intentId: string; offerRef: string; returnedOrder: string | null }) {
  const [state, setState] = useState<CheckoutState>({ phase: "LOADING" });
  const [controller, setController] = useState<CheckoutController | null>(null);

  useEffect(() => {
    let storage: Storage | null = null;
    try { storage = window.sessionStorage; } catch { /* blocked storage: in-memory progress only */ }
    const created = new CheckoutController({
      intentId, offerRef, returnedOrder,
      store: new IntentStore(storage, intentId, offerRef, () => crypto.randomUUID()),
      fetch: (input, init) => window.fetch(input, init),
      myOrigin: window.location.origin,
      navigate: (url) => window.location.assign(url),
    });
    const unsubscribe = created.subscribe(setState);
    queueMicrotask(() => setController(created));
    // Drop `?order=` from the address bar: the order lives in session storage once Commerce owns it.
    if (returnedOrder) window.history.replaceState(null, "", `/checkout/${intentId}`);
    void created.start();
    return () => { unsubscribe(); created.dispose(); };
  }, [intentId, offerRef, returnedOrder]);

  const actions = useMemo(() => ({
    confirm: (input: Parameters<CheckoutController["confirm"]>[0]) => { void controller?.confirm(input); },
    retry: () => { void controller?.retry(); },
    refreshStatus: () => { void controller?.refreshStatus(); },
    openPayment: () => controller?.openPayment(),
    startOver: () => { void controller?.startOver(); },
  }), [controller]);

  return <CheckoutView state={state} actions={actions} />;
}
