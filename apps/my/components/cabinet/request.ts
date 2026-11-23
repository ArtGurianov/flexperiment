/* Per-request binding of the cabinet source to the incoming MY cookie (server only). */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { cabinetSource, sessionCookieHeader } from "./data";
import type { LoadResult } from "./model";

export const requestCabinet = cache(async () => {
  const store = await cookies();
  return cabinetSource({ cookie: sessionCookieHeader(store.getAll()) });
});

/** Signed-out ⇒ my sign-in with a local return path (B validates it; unknown paths fall back to "/"). */
export function requireSignedIn<T>(result: LoadResult<T>, returnPath: string): Exclude<LoadResult<T>, { status: "signed-out" }> {
  if (result.status === "signed-out") redirect(`/sign-in?next=${encodeURIComponent(returnPath)}`);
  return result as Exclude<LoadResult<T>, { status: "signed-out" }>;
}
