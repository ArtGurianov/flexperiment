import type { ReactNode } from "react";

export function ActionModal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop">
      <section className="modal">
        <p className="eyebrow">FINANCIAL / EXPLICIT COMMAND</p>
        <h2>{title}</h2>
        {children}
        <button className="modal-close" onClick={close}>Отмена</button>
      </section>
    </div>
  );
}
