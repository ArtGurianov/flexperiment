"use client";

/* FLEX-123 LMS Navbar profile slot. Same-origin only (coordinator decision, no CORS):
 * GET /v1/lms/session returns the limited view; POST /v1/lms/sign-out deletes the parent MY session.
 * A live MY session without an LMS session shows the guest action; the exchange then signs in without OTP.
 * Inserted into app/(frontend)/layout.tsx by A (R5), with `myOrigin` from the server environment. */
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import NavbarProfile from "../../../../lib/navbar/NavbarProfile";
import type { NavbarConfig } from "../../../../lib/navbar/navbar-core";

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export function lmsNavbarConfig(myOrigin: string): NavbarConfig {
  return { variant: "LMS", myOrigin, sessionUrl: "/v1/lms/session", signOutUrl: "/v1/lms/sign-out" };
}

export default function Navbar({ myOrigin, fetcher }: { myOrigin: string; fetcher?: Fetcher }) {
  const pathname = usePathname();
  const config = useMemo(() => lmsNavbarConfig(myOrigin), [myOrigin]);
  return <NavbarProfile config={config} pathname={pathname} fetcher={fetcher} />;
}
