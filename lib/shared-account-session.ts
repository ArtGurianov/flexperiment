export const PRODUCTION_ACCOUNT_COOKIE_DOMAIN = "flexperiment.ru";

type Environment = Readonly<Record<string, string | undefined>>;

/** Activation is explicit so Stage A and already-qualified rehearsal images keep their behaviour. */
export function sharedAccountCookie(environment: Environment, origins: readonly (string | undefined)[] = []) {
  if (environment.MY_IDENTITY_MODE !== "on" || !environment.MY_SESSION_COOKIE_DOMAIN?.trim()) return null;
  const domain = environment.MY_SESSION_COOKIE_DOMAIN.trim().toLowerCase();
  if (!/^[a-z0-9-]+\.[a-z]{2,}$/.test(domain)) throw new Error("MY_SESSION_COOKIE_DOMAIN_INVALID");
  const targets = [environment.MY_ORIGIN, ...origins].map(value => value && URL.parse(value));
  if (targets.some(target => !target || target.protocol !== "https:" ||
    (target.hostname !== domain && !target.hostname.endsWith(`.${domain}`)))) throw new Error("MY_SESSION_COOKIE_DOMAIN_ORIGIN_MISMATCH");
  const my = targets[0] as URL;
  if (domain === PRODUCTION_ACCOUNT_COOKIE_DOMAIN && (my.origin !== "https://my.flexperiment.ru" ||
    (origins.length > 0 && (targets[1] as URL).origin !== "https://flexperiment.ru") ||
    (origins.length > 1 && (targets[2] as URL).origin !== "https://lab.flexperiment.ru"))) {
    throw new Error("MY_SESSION_COOKIE_DOMAIN_RESERVED_FOR_PRODUCTION");
  }
  const host = my.hostname;
  // Separate names help distinguish environments. The domains, keys and databases also differ.
  return { domain, name: `flex-account-${host.replaceAll(".", "_")}` };
}

export function validSharedAccountSetCookie(value: string, cookie: NonNullable<ReturnType<typeof sharedAccountCookie>>) {
  const [pair, ...attributes] = value.split(";").map(part => part.trim());
  if (!pair.startsWith(`__Secure-${cookie.name}=`)) return false;
  const names = attributes.map(part => part.split("=", 1)[0].trim().toLowerCase());
  if (new Set(names).size !== names.length) return false;
  return attributes.includes(`Domain=${cookie.domain}`) && attributes.includes("Path=/")
    && attributes.includes("Secure") && attributes.includes("HttpOnly") && attributes.includes("SameSite=Lax");
}

// No URL can be supplied by the browser. Reconstruct a link using the configured LMS origin.
export function sharedLmsReturnHref(input: unknown, platformOrigin: string | undefined) {
  if (typeof input !== "string" || !/^(?:\/courses(?:\/[a-z0-9-]{1,80}(?:\/lessons\/[a-z0-9-]{1,120})?)?)$/.test(input)) return null;
  const platform = platformOrigin && URL.parse(platformOrigin);
  return platform && platform.protocol === "https:" && platform.href === platform.origin + "/" ? new URL(input, platform).href : null;
}
