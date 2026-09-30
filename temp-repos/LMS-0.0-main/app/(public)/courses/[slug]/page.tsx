import { getSingleCourse } from "@/app/data/course/get-course";
import { Badge } from "@/components/ui/badge";
import {  buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { env } from "@/lib/env";
import { IconCategory, IconChartBar, IconClock } from "@tabler/icons-react";
import { ChevronDown, Timer } from "lucide-react";
import Image from "next/image";
import { notFound } from "next/navigation";
import { checkIfCourseBought } from "@/app/data/user/user-isEnrolled";
import Link from "next/link";
import EnrollmentButton from "./_components/EnrollmentButton";

type Params = Promise<{ slug: string }>;

const SlugPage = async ({ params }: { params: Params }) => {
  const { slug } = await params;
  const course = await getSingleCourse(slug);

  if (!course) notFound();

  const isEnrolled = await checkIfCourseBought(course.id);

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-3 mt-8">
      {/* Left Content */}
      <div className="order-1 lg:col-span-2 space-y-10">
        {/* Thumbnail */}
        <div className="relative aspect-video w-full overflow-hidden rounded-xl shadow-md">
          <Image
            src={`https://${env.NEXT_PUBLIC_S3_BUCKET_NAME}.t3.storage.dev/${course.fileKey}`}
            alt={`${course.title} thumbnail`}
            fill
            className="object-fill"
            priority
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
        </div>

        {/* Header */}
        <div className="space-y-3">
          <h1 className="text-4xl font-bold tracking-tight">{course.title}</h1>
          <p className="text-muted-foreground text-lg leading-relaxed">
            {course.smallDescription}
          </p>
        </div>

        {/* Badges */}
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary" className="flex items-center gap-1">
            <IconChartBar size={16} />
            <span>{course.level}</span>
          </Badge>
          <Badge variant="secondary" className="flex items-center gap-1">
            <IconCategory size={16} />
            <span>{course.category}</span>
          </Badge>
          <Badge variant="secondary" className="flex items-center gap-1">
            <Timer size={16} />
            <span>{course.duration}h</span>
          </Badge>
        </div>

        <Separator />

        {/* Description */}
        <div className="space-y-4">
          <h2 className="text-2xl font-semibold">Course Description</h2>
          <div
            className="prose prose-neutral dark:prose-invert max-w-none leading-relaxed"
            dangerouslySetInnerHTML={{ __html: course.description }}
          />
        </div>

        {/* Course Content */}
        <div className="space-y-4">
          <div className="space-y-1">
            <h2 className="text-2xl font-semibold">Course Content</h2>
            <p className="text-sm text-muted-foreground">
              {course.chapter.length} chapters ·{" "}
              {course.chapter.reduce(
                (total, chapter) => total + chapter.lesson.length,
                0
              )}{" "}
              lessons
            </p>
          </div>

          <div className="space-y-3">
            {course.chapter.map((chapter, i) => (
              <Collapsible key={chapter.id} defaultOpen={i === 0}>
                <Card className="overflow-hidden">
                  <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-left font-medium hover:bg-muted transition">
                    <div className="flex items-center gap-3">
                      <span className="text-muted-foreground text-sm">
                        {i + 1}.
                      </span>
                      <span>{chapter.title}</span>
                    </div>
                    <ChevronDown className="h-4 w-4 shrink-0 transition-transform data-[state=open]:rotate-180" />
                  </CollapsibleTrigger>

                  <CollapsibleContent>
                    <CardContent className="space-y-2 py-3">
                      {chapter.lesson.map((lesson, j) => (
                        <div
                          key={lesson.id}
                          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition"
                        >
                          <span className="w-5 text-center text-xs">
                            {j + 1}
                          </span>
                          <span>{lesson.title}</span>
                        </div>
                      ))}
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            ))}
          </div>
        </div>
      </div>

      {/* Right Content - Sticky Payment Card */}
      <div className="order-2 lg:col-span-1">
        <Card className="p-6 sticky top-20">
          <h3 className="text-lg font-semibold">Enroll Now</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Get lifetime access and start learning today.
          </p>

          <CardContent className="space-y-4 pt-4">
            {/* Price */}
            <div className="flex items-center justify-between text-lg font-semibold">
              <span>Price:</span>
              <span>
                {new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: "USD",
                }).format(course.price)}
              </span>
            </div>

            {/* Features */}
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <IconClock className="text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Course Duration</p>
                  <p className="text-xs text-muted-foreground">
                    {course.duration} hours
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <IconChartBar className="text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Course Level</p>
                  <p className="text-xs text-muted-foreground">
                    {course.level}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <IconCategory className="text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Course Category</p>
                  <p className="text-xs text-muted-foreground">
                    {course.category}
                  </p>
                </div>
              </div>
            </div>

            {/* CTA */}

            {
              isEnrolled ? (
                <Link className={buttonVariants({ className: 'w-full' })} href={'/dashboard'}>
                  Watch Course
                </Link>
              ) : (
                <EnrollmentButton courseId={course.id}
                />)
            }


            <p className="text-xs text-muted-foreground text-center">
              30-day money-back guarantee
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default SlugPage;
