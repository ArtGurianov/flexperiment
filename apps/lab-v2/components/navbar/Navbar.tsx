"use client";

/* FLEX-123 LAB Navbar profile slot. Guest-only until LAB moves to my (coordinator decision):
 * no session read, no sign-out, a same-tab "Войти через my". The shared config keeps
 * sessionUrl/signOutUrl so LAB attaches later without a rewrite. Inserted into the LAB layout via R5. */
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import NavbarProfile from "../../../../lib/navbar/NavbarProfile";
import type { NavbarConfig } from "../../../../lib/navbar/navbar-core";

export function labNavbarConfig(myOrigin: string): NavbarConfig {
  return { variant: "LAB", myOrigin, sessionUrl: null, signOutUrl: null };
}

export default function Navbar({ myOrigin }: { myOrigin: string }) {
  const pathname = usePathname();
  const config = useMemo(() => labNavbarConfig(myOrigin), [myOrigin]);
  return <NavbarProfile config={config} pathname={pathname} />;
}
