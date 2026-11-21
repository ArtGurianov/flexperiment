import type { ReactNode } from "react";
import HomeSnapShell from "@/components/home/HomeSnapShell";

export default function ExperienceLayout({ children, course, bundle }: {
  children: ReactNode;
  course: ReactNode;
  bundle: ReactNode;
}) {
  return <HomeSnapShell course={course} bundle={bundle}>{children}</HomeSnapShell>;
}
