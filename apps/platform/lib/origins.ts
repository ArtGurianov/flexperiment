const configuredOrigin = (name: "PLATFORM_ORIGIN" | "LAB_ORIGIN" | "ADMIN_ORIGIN" | "API_ORIGIN", fallback: string) => {
  const value = process.env[name]?.trim() ?? fallback;
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error(`${name}_INVALID`); }
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error(`${name}_INVALID`);
  return parsed.origin;
};

export const platformOrigin = () => configuredOrigin("PLATFORM_ORIGIN", "http://localhost:3001");
export const labOrigin = () => configuredOrigin("LAB_ORIGIN", "http://localhost:3000");
export const adminOrigin = () => configuredOrigin("ADMIN_ORIGIN", "http://localhost:3000");
export const apiOrigin = () => configuredOrigin("API_ORIGIN", "http://localhost:3002");
