"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../lib/api";
import type { Page } from "../lib/page";
import { Loading } from "./ui/Loading";
import { Shell } from "./ui/Shell";
import { Login } from "./Login";
import { AuditView, CitiesCatalogue, ControlRoomDashboard, CourseCatalogue, CustomersView, EmailOperationsView, EntitlementsView, IncidentsView, IntegrationView, LabCatalogue, OrdersView, PromotionsView, RefundsView, V2PendingSurface } from "./v2/ControlRoomV2";

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

  const view = page === "dashboard" ? <ControlRoomDashboard />
    : page === "courses" ? <CourseCatalogue />
    : page === "lab" || page === "occurrences" ? <LabCatalogue />
    : page === "cities" ? <CitiesCatalogue />
    : page === "orders" ? <OrdersView />
    : page === "customers" ? <CustomersView />
    : page === "access" ? <EntitlementsView />
    : page === "refunds" ? <RefundsView />
    : page === "promo-codes" ? <PromotionsView />
    : page === "email-attention" ? <EmailOperationsView />
    : page === "incidents" ? <IncidentsView />
    : page === "audit" ? <AuditView />
    : page === "integrations" ? <IntegrationView />
    : <V2PendingSurface area={page} />;

  return <Shell page={page} onLogout={logout}>{view}</Shell>;
}
