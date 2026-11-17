import type { ReactNode } from "react";
import HomeSnapShell from "@/components/home/HomeSnapShell";

export default function ExperienceLayout({ children, course, bundle }: {
  children: ReactNode;
  course: ReactNode;
  bundle: ReactNode;
}) {
  return <HomeSnapShell>{children}{course}{bundle}</HomeSnapShell>;
}
