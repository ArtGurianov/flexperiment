"use client";

import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { api, AdminApiError } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { agentReferralsKeys } from "../../lib/query-keys";
import type { Row } from "../../lib/page";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { Badge } from "../ui/Badge";

const KNOWN_CHANNELS = ["telegram", "vk", "vk_video", "vk_clips", "youtube", "rutube", "tiktok", "likee", "twitch"];

/**
 * PR-C: the per-channel lookups used to live in component state, refreshed
 * by hand after a write - the same bespoke wiring the sanctioned mutation
 * layer exists to remove, and it meant the table could go on showing a
 * policy the operator had just superseded.
 *
 * They are queries now, but still only for channels the operator actually
 * asked about (`enabled`). Mounting all nine eagerly would add nine live
 * queries to a screen the request budget does not even model yet, and
 * `refetchOnWindowFocus` is on globally (lib/query-config.ts) - so an idle
 * tab would spend nine requests on every focus to answer a question nobody
 * asked. What changes is that a looked-up row is now cache state the shared
 * invalidation table can refresh, not private component state only this
 * file knows how to update.
 */
export function ChannelPolicy() {
  const [lookedUp, setLookedUp] = useState<string[]>([]);
  const lookups = useQueries({
    queries: KNOWN_CHANNELS.map((channelKey) => ({
      queryKey: agentReferralsKeys.channelPolicy(channelKey),
      queryFn: () => api<Row>(`/agent-referrals/channel-policy/${channelKey}`),
      enabled: lookedUp.includes(channelKey),
    })),
  });
  const { register, handleSubmit, reset } = useForm<{ channel_key: string; status: "ALLOWED" | "BLOCKED" | "REVIEW_REQUIRED"; effective_from: string; reason: string }>({
    defaultValues: { status: "ALLOWED" },
  });

  const setPolicy = useAdminMutation(
    "agentReferrals.channelPolicy",
    (values: { channel_key: string; status: string; effective_from: string; reason: string }) =>
      api("/agent-referrals/channel-policy", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, effective_from: new Date(values.effective_from).toISOString() }),
      }),
    { context: (values) => ({ channelKey: values.channel_key }) },
  );

  const submit = handleSubmit(async (values) => {
    // Show the channel just written, so the invalidation this command
    // declares actually lands somewhere the operator can see.
    setLookedUp((prev) => (prev.includes(values.channel_key) ? prev : [...prev, values.channel_key]));
    await setPolicy.mutateAsync(values).then(() => reset()).catch(() => undefined);
  });

  return (
    <>
      <Panel title="Политика каналов">
        <table>
          <thead><tr><th>Канал</th><th>Статус</th><th /></tr></thead>
          <tbody>
            {KNOWN_CHANNELS.map((channelKey, index) => {
              const lookup = lookups[index];
              const asked = lookedUp.includes(channelKey);
              return (
                <tr key={channelKey}>
                  <td>{channelKey}</td>
                  <td>
                    {!asked ? "—"
                      : lookup.isLoading ? <Loading />
                        : lookup.isError ? <Notice error={(lookup.error as AdminApiError).code} />
                          : lookup.data ? <Badge>{String(lookup.data.status)}</Badge> : "—"}
                  </td>
                  <td>
                    <button onClick={() => (asked ? void lookup.refetch() : setLookedUp((prev) => [...prev, channelKey]))}>
                      Проверить
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
      <Panel title="Установить политику для канала">
        <form className="form" onSubmit={submit}>
          <label>Канал (точный ключ, не generic-корзина) <input {...register("channel_key", { required: true })} /></label>
          <label>Статус <select {...register("status")}><option value="ALLOWED">ALLOWED</option><option value="BLOCKED">BLOCKED</option><option value="REVIEW_REQUIRED">REVIEW_REQUIRED</option></select></label>
          <label>Действует с <input type="datetime-local" {...register("effective_from", { required: true })} /></label>
          <label>Причина <input {...register("reason", { required: true })} /></label>
          <Notice error={setPolicy.error?.code} />
          <button className="primary" disabled={setPolicy.isPending}>{setPolicy.isPending ? "…" : "Сохранить"}</button>
        </form>
      </Panel>
    </>
  );
}
