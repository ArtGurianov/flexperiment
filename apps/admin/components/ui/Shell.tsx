import type { ReactNode } from "react";
import Link from "next/link";
import type { Page } from "../../lib/page";

const nav: { href: string; page: Page; label: string; index: string }[] = [
  { href: "/", page: "dashboard", label: "Обзор", index: "01" },
  { href: "/courses/", page: "courses", label: "Курсы", index: "02" },
  { href: "/lab/", page: "lab", label: "LAB", index: "03" },
  { href: "/cities/", page: "cities", label: "Города", index: "04" },
  { href: "/orders/", page: "orders", label: "Заказы", index: "05" },
  { href: "/customers/", page: "customers", label: "Клиенты", index: "06" },
  { href: "/access/", page: "access", label: "Доступы", index: "07" },
  { href: "/refunds/", page: "refunds", label: "Возвраты", index: "08" },
  { href: "/promo-codes/", page: "promo-codes", label: "Промо", index: "09" },
  { href: "/email-attention/", page: "email-attention", label: "Email", index: "10" },
  { href: "/incidents/", page: "incidents", label: "Инциденты", index: "11" },
  { href: "/audit/", page: "audit", label: "Аудит", index: "12" },
  { href: "/integrations/", page: "integrations", label: "Refref", index: "13" },
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
