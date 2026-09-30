import Link from "next/link"
import { getAllCoursesForPublic } from "../data/course/get-all-courses"
import { getEnrolledCourses } from "../data/user/get-enrolled-courses"
import { buttonVariants } from "@/components/ui/button"
import PublicCourseCard from "../(public)/_components/PublicCourseCard"
import CourseProgressCard from "./_components/CourseProgressCard"



export default async function DashboardPage() {
  const [courses, enrolledCourses] = await Promise.all([
    getAllCoursesForPublic(),
    getEnrolledCourses()
  ])

  // Filter out courses already enrolled in
  const availableCourses = courses.filter(
    (course) => !enrolledCourses.some(({ Course: enrolled }) => enrolled.id === course.id)
  )

  return (
    <div className="space-y-12">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">My Dashboard</h1>
        <p className="text-muted-foreground">
          Manage your learning and explore new opportunities.
        </p>
      </div>

      {/* Enrolled Courses Section */}
      <section className="space-y-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Enrolled Courses</h2>
          <p className="text-muted-foreground text-sm">
            Here are the courses you have access to.
          </p>
        </div>

        {enrolledCourses.length === 0 ? (
          <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-muted-foreground/30 bg-muted/20 p-8 text-center">
            <p className="text-sm text-muted-foreground">
              You haven’t enrolled in any courses yet.
            </p>
            <Link
              href="/courses"
              className={buttonVariants({ variant: "default" })}
            >
              Browse Courses
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {enrolledCourses.map((course) => (
              <CourseProgressCard key={course.Course.id} data={course}/>
            ))}
          </div>
        )}
      </section>

      {/* Available Courses Section */}
      <section className="space-y-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Available Courses</h2>
          <p className="text-muted-foreground text-sm">
            Explore courses you can purchase and start learning.
          </p>
        </div>

        {availableCourses.length === 0 ? (
          <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-muted-foreground/30 bg-muted/20 p-8 text-center">
            <p className="text-sm text-muted-foreground">
              You have already purchased all available courses.
            </p>
            <Link
              href="/courses"
              className={buttonVariants({ variant: "default" })}
            >
              Browse Courses
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {availableCourses.map((course) => (
              <PublicCourseCard key={course.id} data={course} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
