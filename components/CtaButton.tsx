import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/cn";

const CTA_CLASS =
  "flex w-full items-center justify-center border-4 border-acid bg-ink/20 px-[4%] py-3 text-center font-display leading-none text-acid transition-colors duration-200 motion-reduce:transition-none hover:bg-acid hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-acid";

type AnchorProps = ComponentPropsWithoutRef<"a"> & { href: string };
type ButtonProps = ComponentPropsWithoutRef<"button"> & { href?: never };

// Renders an anchor when given an href and a button otherwise, so a CTA that
// navigates stays a link and keeps its keyboard and context-menu behaviour.
// Classes merge through `cn` rather than concatenating, so a caller passing
// e.g. `w-fit` actually replaces the built-in `w-full` instead of leaving two
// competing width utilities whose winner depends on stylesheet order.
export default function CtaButton(props: AnchorProps | ButtonProps) {
  if (props.href !== undefined) {
    const { className, ...rest } = props;
    return <a className={cn(CTA_CLASS, className)} {...rest} />;
  }

  const { className, ...rest } = props;
  return <button type="button" className={cn(CTA_CLASS, className)} {...rest} />;
}
