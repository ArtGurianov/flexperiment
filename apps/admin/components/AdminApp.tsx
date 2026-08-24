"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../lib/api";
import type { Page } from "../lib/page";
import { Loading } from "./ui/Loading";
import { Shell } from "./ui/Shell";
import { Login } from "./Login";
import { Dashboard } from "./dashboard/Dashboard";
import { Cities } from "./cities/Cities";
import { Occurrences } from "./occurrences/Occurrences";
import { Orders } from "./orders/Orders";
import { Refunds } from "./refunds/Refunds";
import { Settlements } from "./settlements/Settlements";
import { EmailAttention } from "./email-attention/EmailAttention";
import { OperationalIncidents } from "./incidents/Incidents";
import { Audit } from "./audit/Audit";

export function AdminApp({ page }: { page: Page }) {
  const router = useRouter();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    void api<{ authenticated: boolean }>("/session").then(() => setAuthenticated(true)).catch(() => setAuthenticated(false));
  }, []);
  useEffect(() => {
    if (authenticated === false) router.replace("/login/");
  }, [authenticated, router]);

  const logout = async () => {
    await api("/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login/");
  };

  if (page === "login") return <Login />;
  if (authenticated === null) return <main className="boot"><Loading /></main>;
  if (!authenticated) return <main className="boot"><Loading /></main>;

  const view = page === "dashboard" ? <Dashboard />
    : page === "cities" ? <Cities />
    : page === "occurrences" ? <Occurrences />
    : page === "orders" ? <Orders />
    : page === "refunds" ? <Refunds />
    : page === "settlements" ? <Suspense fallback={<Loading />}><Settlements /></Suspense>
    : page === "email-attention" ? <EmailAttention />
    : page === "incidents" ? <Suspense fallback={<Loading />}><OperationalIncidents /></Suspense>
    : <Audit />;

  return <Shell page={page} onLogout={logout}>{view}</Shell>;
}
