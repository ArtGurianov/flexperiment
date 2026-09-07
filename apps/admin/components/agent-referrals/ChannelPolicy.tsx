"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { api, AdminApiError } from "../../lib/api";
import type { Row } from "../../lib/page";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { Badge } from "../ui/Badge";

const KNOWN_CHANNELS = ["telegram", "vk", "vk_video", "vk_clips", "youtube", "rutube", "tiktok", "likee", "twitch"];

export function ChannelPolicy() {
  const [lookups, setLookups] = useState<Record<string, Row | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { register, handleSubmit, reset } = useForm<{ channel_key: string; status: "ALLOWED" | "BLOCKED" | "REVIEW_REQUIRED"; effective_from: string; reason: string }>({
    defaultValues: { status: "ALLOWED" },
  });

  const refreshLookup = async (channelKey: string) => {
    try {
      const result = await api<Row>(`/agent-referrals/channel-policy/${channelKey}`);
      setLookups((prev) => ({ ...prev, [channelKey]: result }));
    } catch { setLookups((prev) => ({ ...prev, [channelKey]: null })); }
  };

  const submit = handleSubmit(async (values) => {
    setBusy(true); setError(null);
    try {
      await api("/agent-referrals/channel-policy", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, effective_from: new Date(values.effective_from).toISOString() }),
      });
      reset();
      await refreshLookup(values.channel_key);
    } catch (failure) {
      setError((failure as AdminApiError).code);
    } finally {
      setBusy(false);
    }
  });

  return (
    <>
      <Panel title="Политика каналов">
        <table>
          <thead><tr><th>Канал</th><th>Статус</th><th /></tr></thead>
          <tbody>
            {KNOWN_CHANNELS.map((channelKey) => (
              <tr key={channelKey}>
                <td>{channelKey}</td>
                <td>{lookups[channelKey] ? <Badge>{String(lookups[channelKey]!.status)}</Badge> : "—"}</td>
                <td><button onClick={() => void refreshLookup(channelKey)}>Проверить</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="Установить политику для канала">
        <form className="form" onSubmit={submit}>
          <label>Канал (точный ключ, не generic-корзина) <input {...register("channel_key", { required: true })} /></label>
          <label>Статус <select {...register("status")}><option value="ALLOWED">ALLOWED</option><option value="BLOCKED">BLOCKED</option><option value="REVIEW_REQUIRED">REVIEW_REQUIRED</option></select></label>
          <label>Действует с <input type="datetime-local" {...register("effective_from", { required: true })} /></label>
          <label>Причина <input {...register("reason", { required: true })} /></label>
          <Notice error={error} />
          <button className="primary" disabled={busy}>{busy ? "…" : "Сохранить"}</button>
        </form>
      </Panel>
    </>
  );
}
