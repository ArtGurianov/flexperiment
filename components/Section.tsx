import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/cn";

/**
 * The shell every content section shares.
 *
 * `@container` is the load-bearing part: the page lives in a fixed max-w-lg
 * column, so viewport units would keep growing on a wide screen while the
 * column stayed 512px. Every section sizes its type in cqw against this
 * context, which only exists because of the class here.
 *
 * `scroll-mt-14` keeps the sticky navbar off a heading the hash links land on,
 * and `overflow-hidden` lets decorative artwork bleed past the column edge
 * without widening the page.
 */
const SECTION_SHELL =
  "@container relative w-full scroll-mt-14 overflow-hidden px-4 py-10 font-display text-bone";

export default function Section({
  className,
  ...props
}: ComponentPropsWithoutRef<"section">) {
  return <section className={cn(SECTION_SHELL, className)} {...props} />;
}

/**
 * The right-aligned acid label that opens a section. Always an h2 so the
 * document outline stays flat and predictable - the teacher section used to
 * render this as a <p>, which left its <h3> credentials hanging without a
 * parent level.
 */
export function SectionLabel({
  className,
  ...props
}: ComponentPropsWithoutRef<"h2">) {
  return (
    <h2
      className={cn(
        "pr-[2cqw] text-right text-[clamp(1.15rem,5cqw,1.6rem)] leading-none uppercase text-acid/90",
        className,
      )}
      {...props}
    />
  );
}
