"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { api, AdminApiError } from "../lib/api";
import { Notice } from "./ui/Notice";

export function Login() {
  const router = useRouter();
  const { register, handleSubmit } = useForm<{ password: string; code: string }>({ defaultValues: { password: "", code: "" } });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = handleSubmit(async ({ password, code }) => {
    setBusy(true); setError(null);
    try {
      await api<{ ok: true }>("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, code: code.trim() }),
      });
      router.replace("/");
    } catch (failure) {
      setError((failure as AdminApiError).code);
    } finally {
      setBusy(false);
    }
  });

  return (
    <main className="login-page">
      <section className="login-card">
        <p className="eyebrow">FLEXPERIMENT / AUTHORITY GATE</p>
        <h1>Вход<br /><i>в control room.</i></h1>
        <p>Сессия хранится только в защищённой HttpOnly cookie. Токены не попадают в браузерное хранилище.</p>
        <form onSubmit={submit}>
          <label>
            Пароль администратора
            <input autoFocus autoComplete="current-password" type="password" {...register("password", { required: true })} />
          </label>
          <label>
            Код из приложения-аутентификатора
            <input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
              {...register("code", { required: true, pattern: /^[0-9]{6}$/ })} />
          </label>
          <Notice error={error} />
          <button className="primary" disabled={busy}>{busy ? "Проверяем…" : "Войти"}</button>
        </form>
      </section>
    </main>
  );
}
