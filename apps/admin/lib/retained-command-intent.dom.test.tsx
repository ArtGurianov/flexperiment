import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";
import { createTestQueryClient, QueryClientWrapper } from "./test-query-client";
import { useAdminMutation } from "./use-admin-mutation";
import { api } from "./api";
import { agentReferralsKeys } from "./query-keys";
import { RetainedIntentNotice } from "../components/ui/RetainedIntentNotice";

/**
 * PR-C2 review round 2, P1: the client-side half of every STALE_BOUND proof.
 *
 * The server proof holds only if the RETRY carries the same observed version
 * the original attempt did. But the sanctioned layer deliberately refreshes
 * authoritative state on an ambiguous outcome, so a form that re-derives its
 * `expected_*` pin from the refreshed query is no longer retrying A - it is
 * authoring a NEW command against B's state, carrying A's body. The server
 * applies it, correctly, because that is what the request now says.
 *
 * This drives the exact sequence the review described, through the real hook
 * and the real notice, rather than asserting the hook's internals.
 */

/**
 * A miniature of every STALE_BOUND surface: it renders a pin from a query,
 * and derives that pin AT SUBMIT TIME - which is precisely the pattern that
 * makes the distinction observable.
 */
function PinnedCommandHarness() {
  const current = useQuery({
    queryKey: agentReferralsKeys.engagement("e1"),
    queryFn: () => api<{ version: number }>("/agent-referrals/engagements/e1"),
  });
  const [body] = useState("X");
  const command = useAdminMutation(
    "agentReferrals.engagementCommand",
    (variables: { body: string; expected_version: number }) =>
      api("/agent-referrals/engagements/e1/suspend", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(variables),
      }),
    { context: () => ({ engagementId: "e1" }) },
  );

  return (
    <div>
      <p>version: {current.data ? String(current.data.version) : "…"}</p>
      <button onClick={() => void command.mutateAsync({ body, expected_version: Number(current.data?.version ?? 0) }).catch(() => undefined)}>
        Отправить
      </button>
      <RetainedIntentNotice
        retained={command.retainedIntent}
        onRetry={() => void command.retryRetainedIntent()}
        onDiscard={command.discardRetainedIntent}
      />
    </div>
  );
}

describe("retained command intent: an ambiguous outcome must not let the pin be re-derived", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  const harness = (posts: Array<Record<string, unknown>>, version: () => number, postOutcome: () => Response) => {
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return postOutcome();
      }
      return { ok: true, status: 200, json: async () => ({ version: version() }) } as Response;
    });
  };

  it("retries with the ORIGINAL pin after the refresh has already moved the screen on", async () => {
    const posts: Array<Record<string, unknown>> = [];
    let version = 1;
    // The command's response is lost. The layer refreshes authoritative
    // state, and by then another writer has moved the aggregate to 2.
    harness(posts, () => version, () => {
      version = 2;
      return { ok: false, status: 0, json: async () => ({ error: { code: "NETWORK_AMBIGUOUS" } }) } as Response;
    });

    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<PinnedCommandHarness />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await screen.findByText("version: 1");
    await user.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ body: "X", expected_version: 1 });

    // The refresh has landed: the screen now shows the NEWER version, and a
    // fresh submit would pin 2. This is the state the review described.
    await screen.findByText("version: 2");

    // The retry replays the retained snapshot - pin 1, not 2. That is what
    // keeps it a retry of A rather than a new command against B.
    await user.click(await screen.findByRole("button", { name: "Повторить прежнюю команду" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual({ body: "X", expected_version: 1 });
  });

  it("a deliberate new action discards the snapshot and derives a fresh pin", async () => {
    const posts: Array<Record<string, unknown>> = [];
    let version = 1;
    harness(posts, () => version, () => {
      version = 2;
      return { ok: false, status: 0, json: async () => ({ error: { code: "NETWORK_AMBIGUOUS" } }) } as Response;
    });

    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<PinnedCommandHarness />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await screen.findByText("version: 1");
    await user.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await screen.findByText("version: 2");

    await user.click(await screen.findByRole("button", { name: "Это новое действие" }));
    // The notice is gone, so the operator is no longer being offered a retry
    // of a command they have decided to replace.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Повторить прежнюю команду" })).toBeNull());

    await user.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    // Authored against what the operator can actually see now.
    expect(posts[1]).toEqual({ body: "X", expected_version: 2 });
  });

  it("a DEFINITIVE refusal retains nothing - the command did not happen, so a fresh pin is correct", async () => {
    const posts: Array<Record<string, unknown>> = [];
    let version = 1;
    harness(posts, () => version, () => {
      version = 2;
      // A business refusal that is classified MAY_MINT_NEW_KEY: the command
      // provably did not commit.
      return { ok: false, status: 409, json: async () => ({ error: { code: "AGENT_REFERRALS_FEATURE_DORMANT" } }) } as Response;
    });

    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<PinnedCommandHarness />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await screen.findByText("version: 1");
    await user.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await screen.findByText("version: 2");

    expect(screen.queryByRole("button", { name: "Повторить прежнюю команду" })).toBeNull();
  });
});
