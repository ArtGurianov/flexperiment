import { getAllCoursesForPublic } from "@/app/data/course/get-all-courses";
import React, { Suspense } from "react";
import PublicCourseCard, { PublicCourseCardSkeleton } from "../_components/PublicCourseCard";

export const dynamic = 'force-dynamic'

const PublicCoursesRoute = () => {
  return (
    <div className="max-w-7xl mx-auto px-6 py-12 space-y-12">
      {/* Hero Section */}
      <div className="text-center max-w-3xl mx-auto space-y-4">
        <h1 className="text-4xl font-bold tracking-tight">Explore Courses</h1>
        <p className="text-lg text-muted-foreground">
          Discover our wide range of courses designed to help you achieve your learning goals.
        </p>
      </div>

      {/* Courses Grid */}
      <Suspense fallback={<CoursesSkeleton />}>
        <RenderCourses />
      </Suspense>
    </div>
  );
};

async function RenderCourses() {
  const courses = await getAllCoursesForPublic();
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-3 gap-6">
      {courses.map((course) => (
        <PublicCourseCard key={course.id} data={course} />
      ))}
    </div>
  );
}

// Grid Skeleton (shows multiple card skeletons)
function CoursesSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-3 gap-6">
      {Array.from({ length: 6 }).map((_, i) => (
        <PublicCourseCardSkeleton key={i} />
      ))}
    </div>
  );
}

export default PublicCoursesRoute;
