import type { ReactNode } from "react";
import HomePolicyLinks from "./HomePolicyLinks";
import HomeSectionLink from "./HomeSectionLink";

export const chapterAction = "inline-flex w-fit items-center gap-4 bg-acid px-5 py-3 font-bold text-ink! hover:bg-orange focus-visible:bg-orange";

export default function HomeChapter({
  path, title, children, bundle = false,
}: {
  path: string;
  title: string;
  children: ReactNode;
  bundle?: boolean;
}) {
  return (
    <section
      data-home-path={path}
      data-home-bundle={bundle ? "" : undefined}
      tabIndex={-1}
      aria-label={title}
      className={`relative h-full snap-start snap-always overflow-y-auto outline-none ${bundle ? "bg-acid text-ink" : "bg-ink text-paper"}`}
    >
      <div className="flex min-h-full flex-col justify-between gap-8 px-[6vw] py-[clamp(1rem,5vh,3rem)]">
        <HomeSectionLink href="/" className="w-fit font-bold hover:underline">↑ К карусели</HomeSectionLink>
        <div className="my-auto grid gap-6 py-4">{children}</div>
        <HomePolicyLinks />
      </div>
    </section>
  );
}
