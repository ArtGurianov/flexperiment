"use client";

import Link from "next/link";
import { createContext, useContext, type ComponentProps } from "react";

export const HomeSectionNavigation = createContext<((path: string) => boolean) | null>(null);

type Props = Omit<ComponentProps<typeof Link>, "href" | "onNavigate" | "prefetch" | "scroll"> & { href: string };

export default function HomeSectionLink({ href, ...props }: Props) {
  const navigate = useContext(HomeSectionNavigation);
  return (
    <Link
      {...props}
      href={href}
      prefetch={false}
      scroll={false}
      onNavigate={navigate ? (event) => {
        event.preventDefault();
        navigate(href);
      } : undefined}
    />
  );
}
