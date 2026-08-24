"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { api, AdminApiError } from "../lib/api";
import { Notice } from "./ui/Notice";

export function Login() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      await api<{ ok: true }>("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      router.replace("/");
    } catch (failure) {
      setError((failure as AdminApiError).code);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-card">
        <p className="eyebrow">FLEXPERIMENT / AUTHORITY GATE</p>
        <h1>Вход<br /><i>в control room.</i></h1>
        <p>Сессия хранится только в защищённой HttpOnly cookie. Токены не попадают в браузерное хранилище.</p>
        <form onSubmit={submit}>
          <label>
            Пароль администратора
            <input autoFocus autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          <Notice error={error} />
          <button className="primary" disabled={busy}>{busy ? "Проверяем…" : "Войти"}</button>
        </form>
      </section>
    </main>
  );
}
