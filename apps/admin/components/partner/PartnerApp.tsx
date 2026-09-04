"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { partnerApi } from "../../lib/partner-api";
import type { PartnerPage } from "../../lib/partner-page";
import { Loading } from "../ui/Loading";
import { PartnerShell } from "./PartnerShell";
import { PartnerLogin } from "./PartnerLogin";
import { Profile } from "./Profile";
import { Agreement } from "./Agreement";
import { Payout } from "./Payout";
import { Engagements } from "./Engagements";

export function PartnerApp({ page }: { page: PartnerPage }) {
  const router = useRouter();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    void partnerApi<{ partner_identity_id: string }>("/me").then(() => setAuthenticated(true)).catch(() => setAuthenticated(false));
  }, []);
  useEffect(() => {
    if (authenticated === false && page !== "login") router.replace("/partner/login");
  }, [authenticated, page, router]);

  const logout = async () => {
    await partnerApi("/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/partner/login");
  };

  if (page === "login") return <PartnerLogin />;
  if (authenticated === null || authenticated === false) return <main className="boot"><Loading /></main>;

  const view = page === "profile" ? <Profile />
    : page === "agreement" ? <Agreement />
    : page === "payout" ? <Payout />
    : page === "engagements" ? <Engagements />
    : <Engagements />;

  return <PartnerShell page={page} onLogout={logout}>{view}</PartnerShell>;
}
