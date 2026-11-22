import type Database from "better-sqlite3";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ErasureRuntimeFence } from "./erasure-fence";
import { confirmLabInterest, discardUndeliveredLabInterest, LabInterestError, requestLabInterest, withdrawLabInterest,
  type LabInterestEmail, type LabInterestRequest } from "./lab-interest";
import { publicLabShowcase } from "./lab-interest-showcase";
import { consumeLabLimit, LabTicketError, labEmail } from "./lab-tickets";
import type { CommerceRuntimeConfig } from "./payment-mode";

const noStore = { "Cache-Control": "no-store" };

/**
 * FLEX-8 public routes. None of them creates a customer, order, quote, hold, guest access, ticket or
 * payment attempt; the interest store is the only thing they write (plus the shared LAB rate-limit
 * buckets, which hold only hashes).
 */
export function registerLabInterestRoutes(parent: Hono, deps: {
  db: Database.Database; config: Pick<CommerceRuntimeConfig, "paymentMode" | "deployEnvironment" | "storefrontSwitch">;
  /** The LAB storefront origin: requests must come from it and links point to it. */
  origin: string; now: () => Date;
  requestSource: (context: Context) => string | undefined;
  /** Derives withdrawal links; without it (or without mail) signups are refused, never stored. */
  secret?: string;
  sendLabInterestEmail?: (message: LabInterestEmail) => Promise<void>;
  erasureFence?: ErasureRuntimeFence;
}) {
  const app = new Hono();
  const available = () => Boolean(deps.secret && deps.sendLabInterestEmail);
  const invalid = (error: unknown) => error instanceof LabInterestError || error instanceof LabTicketError;
  app.onError((error, c) => invalid(error)
    ? c.json({ code: error.message }, 422, noStore)
    : c.json({ code: "LAB_INTEREST_UNAVAILABLE" }, 503, noStore));

  app.get("/v1/lab/showcase", (c) => {
    try { return c.json(publicLabShowcase(deps.db, deps.config, available(), deps.now()), 200, noStore); }
    catch { return c.json({ code: "LAB_SHOWCASE_UNAVAILABLE" }, 503, noStore); }
  });

  app.use("/v1/lab/interest/*", bodyLimit({ maxSize: 4096, onError: (c) => c.json({ code: "LAB_INPUT_TOO_LARGE" }, 413, noStore) }));
  app.use("/v1/lab/interest", bodyLimit({ maxSize: 4096, onError: (c) => c.json({ code: "LAB_INPUT_TOO_LARGE" }, 413, noStore) }));

  app.post("/v1/lab/interest", async (c) => {
    if (c.req.header("origin") !== deps.origin) return c.json({ code: "ORIGIN_FORBIDDEN" }, 403, noStore);
    if (!deps.secret || !deps.sendLabInterestEmail) return c.json({ code: "LAB_INTEREST_EMAIL_UNAVAILABLE" }, 503, noStore);
    let body: LabInterestRequest;
    try { body = await c.req.json<LabInterestRequest>(); } catch { return c.json({ code: "LAB_INPUT_INVALID" }, 422, noStore); }
    const email = labEmail(body?.email), time = deps.now().toISOString();
    const source = deps.requestSource(c);
    if (!source) return c.json({ code: "LAB_SOURCE_UNAVAILABLE" }, 503, noStore);
    if (!consumeLabLimit(deps.db, "interest-source", source, 20, time)) return c.json({ code: "LAB_RATE_LIMITED" }, 429, noStore);
    // Validate consent and city before any per-address effect.
    const accepted = () => c.json({ accepted: true }, 202, noStore);
    if (!consumeLabLimit(deps.db, "interest-source-email", JSON.stringify([source, email]), 3, time)
      || !consumeLabLimit(deps.db, "interest-email", email, 5, time)) return accepted();
    try { deps.erasureFence?.assertIdentity({ email }, "MARKETING"); }
    catch { return accepted(); }
    const prepared = requestLabInterest(deps.db, body, { origin: deps.origin, secret: deps.secret }, time);
    if (prepared) {
      try { await deps.sendLabInterestEmail(prepared.message); }
      catch {
        // Never keep an address whose confirmation did not leave; never log the address or provider body.
        discardUndeliveredLabInterest(deps.db, prepared.signupId);
      }
    }
    return accepted();
  });

  app.post("/v1/lab/interest/confirm", async (c) => {
    if (c.req.header("origin") !== deps.origin) return c.json({ code: "ORIGIN_FORBIDDEN" }, 403, noStore);
    let body: { token?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ code: "LAB_INPUT_INVALID" }, 422, noStore); }
    return c.json(confirmLabInterest(deps.db, body?.token, deps.now().toISOString()), 200, noStore);
  });

  // One-click (RFC 8058) posts come from the mail provider without an Origin, so withdrawal is the one
  // write accepted from anywhere: it can only delete the signup its MAC names.
  app.post("/v1/lab/interest/withdraw", async (c) => {
    if (!deps.secret) return c.json({ code: "LAB_INTEREST_UNAVAILABLE" }, 503, noStore);
    let token: unknown = new URL(c.req.url).searchParams.get("token") ?? undefined;
    if (token === undefined && c.req.header("content-type")?.startsWith("application/json")) {
      try { token = (await c.req.json<{ token?: unknown }>())?.token; } catch { return c.json({ code: "LAB_INPUT_INVALID" }, 422, noStore); }
    }
    return c.json(withdrawLabInterest(deps.db, token, deps.secret), 200, noStore);
  });

  parent.route("/", app);
}
