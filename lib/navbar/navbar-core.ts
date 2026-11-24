/* FLEX-123 Navbar core, shared by apps/platform (LMS) and apps/lab-v2 (LAB).
 * Coordinator decision: no CORS. LMS reads its own same-origin `/v1/me` limited view (#286 §10)
 * and signs out via same-origin `/v1/lms/sign-out`; LAB runs guest-only (sessionUrl null) until
 * LAB moves to my. The config shape stays so LAB can attach later without a rewrite.
 *
 * Privacy rules enforced here (contract #286 §10, FLEX-123):
 * - The Navbar reads only {signedIn, displayName, emailMasked}. Any other field in the answer
 *   (customer id, full e-mail, entitlements, orders) is dropped before it reaches state.
 * - A value that is not visibly masked is never shown as the e-mail.
 * - Nothing is persisted (no storage, no cookies, no URLs) and nothing is logged.
 * - Every answer carries the generation it was requested under; a sign-out or a newer check
 *   bumps the generation, so a late answer cannot restore an e-mail after a confirmed sign-out. */

export type NavbarVariant = "LMS" | "LAB";

export type NavbarProfile = { readonly displayName: string | null; readonly emailMasked: string | null };

export type NavbarState =
  | { readonly kind: "loading" }
  | { readonly kind: "guest" }
  | { readonly kind: "signed-in"; readonly profile: NavbarProfile }
  | { readonly kind: "unavailable" };

export type NavbarConfig = {
  readonly variant: NavbarVariant;
  /** Origin of my.flexperiment.ru for this environment (links in the popover). */
  readonly myOrigin: string;
  /** Read-only session endpoint (same-origin `/v1/me` limited view on LMS). Null: guest-only mode. */
  readonly sessionUrl: string | null;
  /** Sign-out endpoint (`/v1/lms/sign-out` on LMS). Null: no sign-out in the menu. */
  readonly signOutUrl: string | null;
};

const MASKED_EMAIL = /^[^\s@]{0,3}\*{3}@[^\s@]{0,3}\*{3}(\.[a-z0-9-]{1,24})+$/i;
const MAX_NAME = 80;

/** Narrows an untrusted answer to the closed Navbar view. Returns null for a malformed answer. */
export function parseNavbarSession(value: unknown): NavbarState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.signedIn === false) return { kind: "guest" };
  if (record.signedIn !== true) return null;
  const rawName = typeof record.displayName === "string" ? record.displayName.trim() : "";
  const displayName = rawName && rawName.length <= MAX_NAME && !rawName.includes("@") ? rawName : null;
  const emailMasked = typeof record.emailMasked === "string" && MASKED_EMAIL.test(record.emailMasked)
    ? record.emailMasked : null;
  return { kind: "signed-in", profile: { displayName, emailMasked } };
}

/** Exact LMS return paths (contract §7, fixture return-targets.json). */
const LMS_RETURN = [/^\/courses\/[a-z0-9-]{1,80}(\/lessons\/[a-z0-9-]{1,120})?$/, /^\/account$/];

export function safeLmsReturnPath(pathname: string | null | undefined): string | null {
  if (!pathname || pathname.length > 256) return null;
  return LMS_RETURN.some((pattern) => pattern.test(pathname)) ? pathname : null;
}

/** Guest action: same tab, safe return. LMS goes through the exchange receiver (FLEX-121);
 * LAB opens my sign-in (LAB return contract belongs to FLEX-122 and is not invented here). */
export function signInHref(config: NavbarConfig, pathname: string | null | undefined): string {
  if (config.variant === "LMS") {
    const next = safeLmsReturnPath(pathname);
    return next ? `/auth/lms/start?next=${encodeURIComponent(next)}` : "/auth/lms/start";
  }
  return new URL("/sign-in", config.myOrigin).toString();
}

export type NavbarLink = { readonly label: string; readonly href: string };

/** The minimal popover set. No recipient, e-mail or id ever enters these URLs. */
export function cabinetLinks(myOrigin: string): readonly NavbarLink[] {
  const at = (path: string) => new URL(path, myOrigin).toString();
  return [
    { label: "Личный кабинет", href: at("/") },
    { label: "Мои курсы", href: at("/courses") },
    { label: "Мои билеты", href: at("/tickets") },
  ];
}

export function isCrossOrigin(url: string, pageOrigin: string): boolean {
  try { return new URL(url, pageOrigin).origin !== pageOrigin; } catch { return true; }
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/** Small state holder with generation fencing. UI subscribes; tests drive it directly. */
export function createNavbarSession(config: NavbarConfig, options: {
  readonly fetcher?: Fetcher;
  readonly pageOrigin: string;
  readonly onChange: (state: NavbarState) => void;
}) {
  const fetcher: Fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const crossOrigin = (url: string) => isCrossOrigin(url, options.pageOrigin);
  let generation = 0;
  let state: NavbarState = { kind: "loading" };
  let inFlight: Promise<void> | null = null;
  const set = (next: NavbarState) => { state = next; options.onChange(next); };

  async function check(): Promise<void> {
    const sessionUrl = config.sessionUrl;
    if (!sessionUrl) { generation += 1; if (state.kind !== "guest") set({ kind: "guest" }); return; }
    if (inFlight) return inFlight;
    const issued = ++generation;
    const pending: Promise<void> = (async () => {
      let next: NavbarState;
      try {
        const response = await fetcher(sessionUrl, {
          method: "GET", cache: "no-store", redirect: "error",
          credentials: crossOrigin(sessionUrl) ? "include" : "same-origin",
          headers: { Accept: "application/json" },
        });
        if (response.status === 401) next = { kind: "guest" };
        else if (!response.ok) next = { kind: "unavailable" };
        else next = parseNavbarSession(await response.json().catch(() => null)) ?? { kind: "unavailable" };
      } catch { next = { kind: "unavailable" }; }
      if (issued === generation) set(next);
    })().finally(() => { if (inFlight === pending) inFlight = null; });
    inFlight = pending;
    return pending;
  }

  async function signOut(): Promise<boolean> {
    if (!config.signOutUrl) return false;
    generation += 1; // fence every pending answer before the request leaves
    inFlight = null;
    set({ kind: "guest" });
    const fenced = generation;
    try {
      const cross = crossOrigin(config.signOutUrl);
      const response = await fetcher(config.signOutUrl, {
        method: "POST", cache: "no-store", redirect: "error",
        credentials: cross ? "include" : "same-origin",
        headers: cross ? { "X-Flex-Navbar": "1" } : {},
      });
      if (response.ok) return true;
    } catch { /* fall through: the session may still be live */ }
    if (fenced === generation) set({ kind: "unavailable" });
    return false;
  }

  return { check, signOut, current: () => state };
}
