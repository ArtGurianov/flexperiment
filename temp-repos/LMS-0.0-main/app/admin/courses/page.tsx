import { BookOpen, DollarSign, Plus, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import { adminGetCourse } from "@/app/data/admin/admin-get-courses";
import AdminCourseCard, { AdminCourseCardSkeleton } from "./_components/AdminCourseCard";
import { Suspense } from "react";

const CoursePage = async () => {
  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-primary/5 to-background">
      <div className="container mx-auto px-6 py-12">
        {/* Floating background elements */}
        <div className="fixed inset-0 overflow-hidden pointer-events-none">
          <div className="absolute -top-40 -right-40 w-96 h-96 bg-primary/10 rounded-full blur-3xl animate-float" />
          <div
            className="absolute -bottom-40 -left-40 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-float"
            style={{ animationDelay: "2s" }}
          />
        </div>

        {/* Header */}
        <div className="relative z-10 flex flex-col lg:flex-row justify-between items-start lg:items-center mb-16 animate-fade-in">
          <div className="mb-6 lg:mb-0">
            <h1 className="text-5xl lg:text-6xl font-extrabold gradient-text mb-4">My Courses</h1>
            <p className="text-muted-foreground text-lg max-w-md leading-relaxed">
              Create, manage, and publish your educational masterpieces
            </p>
          </div>

          <Link href="/admin/courses/create">
            <Button className="btn-gradient bg-gradient-to-r from-primary to-purple-500 text-white font-semibold px-8 py-4 rounded-2xl text-lg group">
              <Plus className="w-5 h-5 mr-3 transition-transform group-hover:rotate-90" />
              Create New Course
            </Button>
          </Link>
        </div>
        <Suspense fallback={<AdminCourseCardSkeleton />}>
          <RenderCourse />
        </Suspense>
      </div>
    </div>
  );
};

export default CoursePage;

export async function RenderCourse() {
  const courses = await adminGetCourse();

  const totalCourses = courses.length;
  const publishedCount = courses.filter((c) => c.status === "PUBLISHED").length;
  const totalValue = courses.reduce((sum, c) => sum + c.price, 0);
  return (
    <>
      {/* Stats Cards */}
      <div className="relative z-10 grid grid-cols-1 md:grid-cols-3 gap-8 mb-16">
        {/* Total Courses */}
        <Card className="card-gradient card-hover border-0 rounded-3xl overflow-hidden animate-scale-in">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-2xl bg-primary/10">
                <BookOpen className="w-8 h-8 text-primary" />
              </div>
              <div>
                <CardTitle className="text-4xl font-bold gradient-text">{totalCourses}</CardTitle>
                <p className="text-muted-foreground font-medium">Total Courses</p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="h-2 bg-primary/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-primary to-purple-500 rounded-full transition-all duration-1000 ease-out"
                style={{
                  width: `${Math.min((totalCourses / 10) * 100, 100)}%`,
                }}
              />
            </div>
          </CardContent>
        </Card>

        {/* Published */}
        <Card
          className="card-gradient card-hover border-0 rounded-3xl overflow-hidden animate-scale-in"
          style={{ animationDelay: "0.1s" }}
        >
          <CardHeader className="pb-3">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-2xl bg-green-500/10">
                <TrendingUp className="w-8 h-8 text-green-600" />
              </div>
              <div>
                <CardTitle className="text-4xl font-bold text-green-600">
                  {publishedCount}
                </CardTitle>
                <p className="text-muted-foreground font-medium">Published</p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="h-2 bg-green-500/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-green-500 to-emerald-500 rounded-full transition-all duration-1000 ease-out"
                style={{
                  width: `${totalCourses > 0 ? (publishedCount / totalCourses) * 100 : 0}%`,
                }}
              />
            </div>
          </CardContent>
        </Card>

        {/* Total Value */}
        <Card
          className="card-gradient card-hover border-0 rounded-3xl overflow-hidden animate-scale-in"
          style={{ animationDelay: "0.2s" }}
        >
          <CardHeader className="pb-3">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-2xl bg-yellow-500/10">
                <DollarSign className="w-8 h-8 text-yellow-600" />
              </div>
              <div>
                <CardTitle className="text-4xl font-bold text-yellow-600">
                  ${totalValue.toLocaleString()}
                </CardTitle>
                <p className="text-muted-foreground font-medium">Total Value</p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="h-2 bg-yellow-500/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-yellow-500 to-orange-500 rounded-full transition-all duration-1000 ease-out"
                style={{
                  width: `${Math.min((totalValue / 1000) * 100, 100)}%`,
                }}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Courses Grid */}
      {courses.length > 0 ? (
        <div className="relative z-10">
          <h2 className="text-2xl font-bold text-foreground mb-8">Your Course Collection</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {courses.map((course, index) => (
              <div
                key={course.id}
                className="animate-scale-in"
                style={{ animationDelay: `${0.1 * (index + 1)}s` }}
              >
                <AdminCourseCard data={course} />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="relative z-10 text-center py-24">
          <div className="card-gradient rounded-3xl p-12 max-w-lg mx-auto">
            <BookOpen className="w-20 h-20 text-primary mx-auto mb-6 animate-float" />
            <h3 className="text-2xl font-bold gradient-text mb-4">No courses yet</h3>
            <p className="text-muted-foreground mb-8 leading-relaxed">
              Start your teaching journey by creating your first course. Share your knowledge with
              the world!
            </p>
            <Link href="/admin/courses/create">
              <Button className="btn-gradient text-white font-semibold px-8 py-3 rounded-xl">
                <Plus className="w-5 h-5 mr-2" />
                Create Your First Course
              </Button>
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
