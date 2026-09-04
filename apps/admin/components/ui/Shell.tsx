import type { ReactNode } from "react";
import Link from "next/link";
import type { Page } from "../../lib/page";

const nav: { href: string; page: Page; label: string; index: string }[] = [
  { href: "/", page: "dashboard", label: "Обзор", index: "01" },
  { href: "/cities/", page: "cities", label: "Города", index: "02" },
  { href: "/occurrences/", page: "occurrences", label: "События", index: "03" },
  { href: "/orders/", page: "orders", label: "Заказы", index: "04" },
  { href: "/refunds/", page: "refunds", label: "Возвраты", index: "05" },
  { href: "/settlements/", page: "settlements", label: "Расчёты", index: "06" },
  { href: "/email-attention/", page: "email-attention", label: "Email attention", index: "07" },
  { href: "/incidents/", page: "incidents", label: "Инциденты", index: "08" },
  { href: "/audit/", page: "audit", label: "Аудит", index: "09" },
  { href: "/agents/", page: "agents", label: "Агенты", index: "10" },
  { href: "/promo-codes/", page: "promo-codes", label: "Промокоды", index: "11" },
  { href: "/agent-referrals/", page: "agent-referrals", label: "Agent Referrals", index: "12" },
];

export function Shell({ page, children, onLogout }: { page: Page; children: ReactNode; onLogout: () => void }) {
  return (
    <div className="shell">
      <aside className="rail">
        <Link href="/" className="brand"><span>FX</span><strong>CONTROL<br />ROOM</strong></Link>
        <nav>
          {nav.map((item) => (
            <Link className={item.page === page ? "nav-active" : ""} href={item.href} key={item.page}>
              <em>{item.index}</em>{item.label}
            </Link>
          ))}
        </nav>
        <button className="logout" onClick={onLogout}>Выйти из сессии <span>↗</span></button>
      </aside>
      <main className="content">
        <header className="topline">
          <span>admin.flexperiment.ru</span>
          <span className="live-dot">LIVE DATA / AUTO REFRESH</span>
        </header>
        {children}
      </main>
    </div>
  );
}
