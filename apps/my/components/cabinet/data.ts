/* FLEX-123 cabinet data layer (server only). Pages never fetch on their own: they call a
 * CabinetSource, which returns closed DTOs from ./model.
 *
 * Authorization stays in Commerce. The loader sends no customer id, e-mail or other selector:
 * fixed paths only, plus the presented MY session cookie, so Commerce answers for the session
 * owner or not at all. The surface is fixed to MY exactly as the /v1 proxy does (contract §1). */
import { myOrigin } from "../../lib/commerce-proxy";
import { CABINET_FIXTURES, isCabinetFixtureName, type CabinetFixtureName } from "./fixtures";
import {
  parseCourses, parseOrders, parseProfile, parseTickets,
  type CabinetCourse, type CabinetOrder, type CabinetProfile, type CabinetTicket, type LoadResult,
} from "./model";

type Environment = Readonly<Record<string, string | undefined>>;
type Send = typeof fetch;

export type CabinetSource = {
  readonly profile: () => Promise<LoadResult<CabinetProfile>>;
  readonly courses: () => Promise<LoadResult<CabinetCourse[]>>;
  readonly tickets: () => Promise<LoadResult<CabinetTicket[]>>;
  readonly orders: () => Promise<LoadResult<CabinetOrder[]>>;
};

/** Only the Better Auth MY session cookie leaves my (host-only on my, contract §3). */
export const SESSION_COOKIE_NAMES: ReadonlySet<string> = new Set(["__Secure-better-auth.session_token", "better-auth.session_token"]);

export function sessionCookieHeader(cookies: ReadonlyArray<{ name: string; value: string }>): string | null {
  const kept = cookies.filter((cookie) => SESSION_COOKIE_NAMES.has(cookie.name) && /^[\x21-\x7e]{1,4096}$/.test(cookie.value));
  return kept.length ? kept.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") : null;
}

/** Live and proposed read routes. Courses → B (R1), tickets → D (R2); 404 there means "not live yet". */
export const CABINET_ROUTES = {
  profile: "/v1/my/profile",
  courses: "/v1/my/courses",
  tickets: "/v1/my/tickets",
  orders: "/v1/me/orders",
} as const;

const PENDING_ROUTES: ReadonlySet<string> = new Set([CABINET_ROUTES.courses, CABINET_ROUTES.tickets]);

async function read<T>(path: string, parse: (value: unknown) => T | null, input: {
  cookie: string | null; environment: Environment; send: Send;
}): Promise<LoadResult<T>> {
  if (!input.cookie) return { status: "signed-out" };
  const origin = myOrigin(input.environment);
  const upstream = input.environment.COMMERCE_INTERNAL_ORIGIN?.trim();
  if (!origin || !upstream) return { status: "unavailable" };
  let response: Response;
  try {
    response = await input.send(new URL(path, upstream), {
      method: "GET", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(5000),
      headers: {
        accept: "application/json",
        cookie: input.cookie,
        "x-forwarded-host": origin.host,
        "x-forwarded-proto": origin.protocol.replace(":", ""),
      },
    });
  } catch { return { status: "unavailable" }; } // no URL, cookie or exception text in logs
  const body = await response.json().catch(() => null) as unknown;
  if (response.status === 401) return { status: "signed-out" };
  if (response.status === 403 && (body as { code?: unknown } | null)?.code === "CONSENT_REQUIRED") return { status: "consent-required" };
  if (response.status === 404 && PENDING_ROUTES.has(path)) return { status: "not-yet-available" };
  if (response.status !== 200) return { status: "unavailable" };
  const parsed = parse(body);
  return parsed === null ? { status: "unavailable" } : { status: "ok", data: parsed };
}

export function commerceCabinetSource(input: { cookie: string | null; environment?: Environment; send?: Send }): CabinetSource {
  const context = { cookie: input.cookie, environment: input.environment ?? process.env, send: input.send ?? fetch };
  return {
    profile: () => read(CABINET_ROUTES.profile, parseProfile, context),
    courses: () => read(CABINET_ROUTES.courses, parseCourses, context),
    tickets: () => read(CABINET_ROUTES.tickets, parseTickets, context),
    orders: () => read(CABINET_ROUTES.orders, parseOrders, context),
  };
}

export function fixtureCabinetSource(name: CabinetFixtureName): CabinetSource {
  if (name === "signed-out" || name === "consent-required") {
    const result = { status: name } as const;
    const constant = async () => result;
    return { profile: constant, courses: constant, tickets: constant, orders: constant };
  }
  const raw = CABINET_FIXTURES[name];
  // Fixtures go through the same parsers as Commerce answers.
  const from = <T>(value: unknown, parse: (v: unknown) => T | null) => async (): Promise<LoadResult<T>> => {
    const parsed = parse(value);
    return parsed === null ? { status: "unavailable" } : { status: "ok", data: parsed };
  };
  return {
    profile: from(raw.profile, parseProfile),
    courses: from(raw.courses, parseCourses),
    tickets: from(raw.tickets, parseTickets),
    orders: from(raw.orders, parseOrders),
  };
}

/** Fixtures are a local/test switch only; a production build always reads Commerce. */
export function fixtureName(environment: Environment): CabinetFixtureName | null {
  if (environment.NODE_ENV === "production") return null;
  const value = environment.MY_CABINET_FIXTURE?.trim();
  return isCabinetFixtureName(value) ? value : null;
}

export function cabinetSource(input: { cookie: string | null; environment?: Environment; send?: Send }): CabinetSource {
  const environment = input.environment ?? process.env;
  const fixture = fixtureName(environment);
  return fixture ? fixtureCabinetSource(fixture) : commerceCabinetSource({ ...input, environment });
}

/** Origins for outbound links. Missing LAB_ORIGIN ⇒ tickets render without a view link. */
export function cabinetOrigins(environment: Environment = process.env) {
  const origin = (value: string | undefined) => {
    try { return value?.trim() ? new URL(value.trim()).origin : null; } catch { return null; }
  };
  return {
    platform: origin(environment.PLATFORM_ORIGIN) ?? "http://localhost:3001",
    lab: origin(environment.LAB_ORIGIN),
  };
}
