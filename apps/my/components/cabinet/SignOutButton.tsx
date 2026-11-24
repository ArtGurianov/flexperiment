"use client";

/* FLEX-123 "Выйти" on my: same-origin POST /v1/my/sign-out (exact Origin is set by the browser;
 * Commerce deletes the MY session row ⇒ cascades LMS sessions and exchanges, contract §8). */
import { useState } from "react";

export default function SignOutButton() {
  const [state, setState] = useState<"idle" | "pending" | "failed">("idle");
  const signOut = async () => {
    setState("pending");
    try {
      const response = await fetch("/v1/my/sign-out", { method: "POST", credentials: "same-origin", cache: "no-store" });
      if (response.ok) { window.location.replace("/sign-in"); return; }
    } catch { /* fall through */ }
    setState("failed");
  };
  return (
    <>
      <button type="button" className="cabinet-signout" onClick={signOut} disabled={state === "pending"}>Выйти</button>
      {state === "failed" && <span role="status" className="cabinet-meta"> Не удалось выйти. Повторите.</span>}
    </>
  );
}
