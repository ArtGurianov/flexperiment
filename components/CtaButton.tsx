import type { ComponentPropsWithoutRef } from "react";

const CTA_CLASS =
  "flex w-full items-center justify-center border-4 border-acid bg-[rgb(15_16_11_/_0.2)] px-[4%] py-3 text-center font-display leading-none text-acid uppercase transition-colors duration-200 hover:bg-acid hover:text-[#171812] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-acid";

type AnchorProps = ComponentPropsWithoutRef<"a"> & { href: string };
type ButtonProps = ComponentPropsWithoutRef<"button"> & { href?: never };

// Renders an anchor when given an href and a button otherwise, so a CTA that
// navigates stays a link and keeps its keyboard and context-menu behaviour.
export default function CtaButton(props: AnchorProps | ButtonProps) {
  if (props.href !== undefined) {
    const { className = "", ...rest } = props;
    return <a className={`${CTA_CLASS} ${className}`} {...rest} />;
  }

  const { className = "", ...rest } = props;
  return <button type="button" className={`${CTA_CLASS} ${className}`} {...rest} />;
}
