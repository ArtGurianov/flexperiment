import { describe, expect, it, vi } from "vitest";
import { createLabInterestMailDelivery, labInterestMailContent } from "../src/lab-interest-mail";

const env = { NOTISEND_API_KEY: "synthetic-key", NOTISEND_FROM_EMAIL: "lab@example.test", NOTISEND_FROM_NAME: "Flexperiment LAB",
  NOTISEND_REPLY_TO: "reply@example.test" };
const confirm = { kind: "CONFIRM" as const, email: "fan@example.test", confirmUrl: "https://lab.example/interest#confirm=t",
  withdrawUrl: "https://lab.example/interest#withdraw=w", cityTitle: "Новосибирск" };
const notice = { kind: "NOTICE" as const, email: "fan@example.test", noticeKey: "opened", subject: "Продажи LAB открыты", message: "<b>Билеты</b>",
  storefrontUrl: "https://lab.example", withdrawUrl: "https://lab.example/interest#withdraw=w",
  headers: { "List-Unsubscribe": "<https://api.example/v1/lab/interest/withdraw?token=w>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" as const } };

describe("FLEX-8 LAB interest mail adapter (fake transport only)", () => {
  it("is not configured without the complete NotiSend sender or with an HTTP relay", () => {
    expect(createLabInterestMailDelivery({}).configured).toBe(false);
    expect(createLabInterestMailDelivery({ ...env, NOTISEND_REPLY_TO: "" }).configured).toBe(false);
    expect(createLabInterestMailDelivery({ ...env, AUTH_EMAIL_DELIVERY_ENDPOINT: "https://relay.example" }).configured).toBe(false);
  });

  it("sends a non-advertising confirmation and a notice with one-click unsubscribe, escaping content", async () => {
    const request = vi.fn(async () => Response.json({ id: "fixture-1", status: "queued" }));
    const delivery = createLabInterestMailDelivery(env, request as unknown as typeof fetch);
    if (!delivery.configured) throw new Error("expected configured");
    await delivery.send(confirm); await delivery.sendNotice(notice, start => start());
    const [first, second] = request.mock.calls.map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string));
    expect(first).toMatchObject({ to: "fan@example.test", subject: "Подтвердите предзапись Flexperiment LAB" });
    expect(first.text).toContain("не резервирует место"); expect(first.smtp_headers["List-Unsubscribe"]).toBeUndefined();
    expect(second.smtp_headers).toMatchObject(notice.headers);
    expect(second.html).toContain("&lt;b&gt;Билеты&lt;/b&gt;"); expect(second.html).toContain("Отказаться от уведомлений");
  });

  it("maps provider failures to fixed codes without leaking the address or body", async () => {
    for (const [status, code] of [[503, "LAB_INTEREST_MAIL_AMBIGUOUS"], [422, "LAB_INTEREST_MAIL_REJECTED"]] as const) {
      const delivery = createLabInterestMailDelivery(env, (async () => new Response("fan@example.test secret", { status })) as typeof fetch);
      if (!delivery.configured) throw new Error("expected configured");
      await expect(delivery.send(confirm)).rejects.toThrow(new RegExp(`^${code}$`));
    }
    const failing = createLabInterestMailDelivery(env, (async () => { throw new Error("socket fan@example.test"); }) as typeof fetch);
    if (!failing.configured) throw new Error("expected configured");
    await expect(failing.send(confirm)).rejects.toThrow(/^LAB_INTEREST_MAIL_AMBIGUOUS$/);
  });

  it("keeps the confirmation free of advertising wording", () => {
    expect(labInterestMailContent(confirm).text).not.toMatch(/скидк|акци|купите/i);
  });

  it.each([
    [JSON.stringify({ status: "skipped" }), "LAB_INTEREST_MAIL_REJECTED"],
    [JSON.stringify({ status: "queued", id: "valid", errors: ["refused"] }), "LAB_INTEREST_MAIL_REJECTED"],
    [JSON.stringify({ status: "queued" }), "LAB_INTEREST_MAIL_AMBIGUOUS"],
    ["?", "LAB_INTEREST_MAIL_AMBIGUOUS"],
    [JSON.stringify({ status: "queued", id: "valid", padding: "x".repeat(17_000) }), "LAB_INTEREST_MAIL_AMBIGUOUS"],
  ])("requires a bounded provider acknowledgement", async (body, code) => {
    const request = vi.fn<typeof fetch>(async () => new Response(body, { status: 200 }));
    const delivery = createLabInterestMailDelivery(env, request);
    if (!delivery.configured) throw new Error("expected configured");
    await expect(delivery.send(confirm)).rejects.toThrow(new RegExp(`^${code}$`));
    expect(request).toHaveBeenCalledOnce();
  });
});
