"use client";

import { usePathname } from "next/navigation";
import SignOutButton from "./SignOutButton";

export const CABINET_PAGES = [
  { href: "/", label: "Кабинет" },
  { href: "/courses", label: "Мои курсы" },
  { href: "/tickets", label: "Мои билеты" },
  { href: "/orders", label: "Заказы" },
  { href: "/profile", label: "Профиль" },
] as const;

export default function CabinetNav() {
  const pathname = usePathname();
  return (
    <nav className="cabinet-nav" aria-label="Личный кабинет">
      {CABINET_PAGES.map((page) => (
        <a key={page.href} href={page.href} aria-current={pathname === page.href ? "page" : undefined}>{page.label}</a>
      ))}
      <span className="cabinet-signout-slot"><SignOutButton /></span>
    </nav>
  );
}
