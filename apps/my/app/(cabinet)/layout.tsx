import type { ReactNode } from "react";
import CabinetNav from "@/components/cabinet/CabinetNav";
import "./cabinet.css";

/** FLEX-123 cabinet shell on my. Private pages only: dynamic, no-store (security headers), never indexed. */
export default function CabinetLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <CabinetNav />
      {children}
    </>
  );
}
