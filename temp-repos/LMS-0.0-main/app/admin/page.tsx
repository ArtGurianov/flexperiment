import { ChartAreaInteractive } from "@/components/sidebar/chart-area-interactive";
import { SectionCards } from "@/components/sidebar/section-cards";
import { adminGetEnrollmentStat } from "../data/admin/admin-get-enrollment-stats";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { adminGetRecentCourses } from "../data/admin/admin-get-recent-courses";
import AdminCourseCard from "./courses/_components/AdminCourseCard";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";

export default async function AdminPage() {
  const enrollmentData = await adminGetEnrollmentStat();

  return (
    <div className="space-y-8">
      {/* Dashboard Summary */}
      <SectionCards />

      {/* Enrollment Chart */}
      <div className="rounded-xl bg-card shadow-md p-6">
        <h2 className="text-lg font-semibold mb-4">Enrollment Overview</h2>
        <ChartAreaInteractive data={enrollmentData} />
      </div>

      {/* Recent Courses Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Recent Courses</h2>
          <Link
            className={buttonVariants({ variant: "outline" })}
            href="/admin/courses"
          >
            View All Courses
          </Link>
        </div>

        <Suspense fallback={<RenderRecentCoursesSkeleton />}>
          <RenderRecentCourses />
        </Suspense>
      </div>
    </div>
  );
}

async function RenderRecentCourses() {
  const data = await adminGetRecentCourses();

  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4">
        <div className="rounded-xl bg-muted/50 p-6 text-center text-sm text-muted-foreground">
          No recent courses available yet.
        </div>
        <Link
          href={"/admin/courses/create"}
          className={buttonVariants({ variant: "default" })}
        >
          Create Course
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col md:flex-row gap-6 justify-center">
      {data.map((course) => (
        <div
          key={course.id}
          className="transition-transform transform hover:scale-105"
        >
          <AdminCourseCard data={course} />
        </div>
      ))}
    </div>
  );
}

function RenderRecentCoursesSkeleton() {
  return (
    <div className="flex flex-col md:flex-row gap-6 justify-center">
      {[...Array(2)].map((_, i) => (
        <div
          key={i}
          className="flex flex-col md:flex-row gap-4 p-4 rounded-xl bg-card shadow-sm animate-pulse"
        >
          {/* Thumbnail Skeleton */}
          <Skeleton className="h-16 w-24 rounded-md" />
          {/* Text Skeletons */}
          <div className="flex-1 flex flex-col justify-center space-y-2">
            <Skeleton className="h-4 w-3/4 rounded-md" />
            <Skeleton className="h-4 w-1/2 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}
