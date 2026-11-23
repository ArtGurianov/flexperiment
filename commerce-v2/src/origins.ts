export type Storefront = "COURSES" | "LAB";

export type CommerceOrigins = {
  readonly platform: string;
  readonly lab: string;
  readonly admin: string;
  readonly api: string;
  /** FLEX-120: present only when `MY_ORIGIN` is configured; absent means no MY surface. */
  readonly my?: string;
};

type Environment = Readonly<Record<string, string | undefined>>;

const origin = (value: string, name: string, production: boolean) => {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error(`${name}_INVALID`); }
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash
    || (production && parsed.protocol !== "https:")) throw new Error(`${name}_INVALID`);
  return parsed.origin;
};

export function loadCommerceOrigins(environment: Environment = process.env): CommerceOrigins {
  const requireExplicit = environment.NODE_ENV === "production" || environment.DEPLOY_ENV === "production";
  const requireHttps = environment.DEPLOY_ENV === "production";
  const configured = (name: string, fallback: string) => {
    const value = environment[name]?.trim();
    if (requireExplicit && !value) throw new Error(`${name}_REQUIRED`);
    return origin(value ?? fallback, name, requireHttps);
  };
  const origins: CommerceOrigins = {
    platform: configured("PLATFORM_ORIGIN", "http://localhost:3001"),
    lab: configured("LAB_ORIGIN", "http://localhost:3000"),
    admin: configured("ADMIN_ORIGIN", "http://localhost:3000"),
    api: configured("API_ORIGIN", "http://localhost:3002"),
  };
  // Additive and optional: without MY_ORIGIN the returned object is unchanged.
  const my = environment.MY_ORIGIN?.trim();
  if (!my) return origins;
  const parsed = origin(my, "MY_ORIGIN", requireHttps);
  if (Object.values(origins).includes(parsed)) throw new Error("MY_ORIGIN_INVALID");
  return { ...origins, my: parsed };
}

export const storefrontOrigin = (origins: CommerceOrigins, storefront: Storefront) =>
  storefront === "LAB" ? origins.lab : origins.platform;
