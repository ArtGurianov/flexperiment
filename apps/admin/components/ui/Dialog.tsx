"use client";

import type { ReactNode } from "react";

export function Dialog({ title, close, children, className = "" }: { title: string; close: () => void; children: ReactNode; className?: string }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <section className={`modal ${className}`.trim()} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" className="modal-close" aria-label="Закрыть окно" onClick={close}>×</button>
        {children}
      </section>
    </div>
  );
}
