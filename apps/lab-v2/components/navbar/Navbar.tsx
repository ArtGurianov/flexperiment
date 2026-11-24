"use client";

/* FLEX-123 LAB Navbar profile slot. Guest-only until LAB moves to my (coordinator decision):
 * no session read, no sign-out, a same-tab "Войти через my". The shared config keeps
 * sessionUrl/signOutUrl so LAB attaches later without a rewrite. Inserted into the LAB layout via R5. */
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import NavbarProfile from "../../../../lib/navbar/NavbarProfile";
import type { NavbarConfig } from "../../../../lib/navbar/navbar-core";

export function labNavbarConfig(myOrigin: string, sharedSession = false): NavbarConfig {
  return { variant: "LAB", myOrigin,
    sessionUrl: sharedSession ? new URL("/v1/my/storefront-session", myOrigin).href : null,
    signOutUrl: sharedSession ? new URL("/v1/my/storefront-sign-out", myOrigin).href : null,
  };
}

export default function Navbar({ myOrigin, sharedSession = false }: { myOrigin: string; sharedSession?: boolean }) {
  const pathname = usePathname();
  const config = useMemo(() => labNavbarConfig(myOrigin, sharedSession), [myOrigin, sharedSession]);
  return <NavbarProfile config={config} pathname={pathname} />;
}
