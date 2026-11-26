import { Suspense, type ReactNode } from "react";
import HomeSnapShell from "@/components/home/HomeSnapShell";

export default function ExperienceLayout({ children, course, bundle }: {
  children: ReactNode;
  course: ReactNode;
  bundle: ReactNode;
}) {
  return (
    <Suspense fallback={children}>
      <HomeSnapShell course={course} bundle={bundle}>{children}</HomeSnapShell>
    </Suspense>
  );
}
