import type { ReactNode } from "react";
import { Dialog } from "./Dialog";

export function ActionModal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  return (
    <Dialog title={title} close={close}>
      <p className="eyebrow">FINANCIAL / EXPLICIT COMMAND</p>
      <h2>{title}</h2>
      {children}
    </Dialog>
  );
}
