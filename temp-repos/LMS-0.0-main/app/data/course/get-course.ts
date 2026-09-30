import "server-only";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";

export async function getSingleCourse(slug: string) {
  const course = await prisma.course.findUnique({
    where: { slug: slug },
    select: {
      id: true,
      title: true,
      description: true,
      price: true,
      smallDescription: true,
      fileKey: true,
      category: true,
      level: true,
      duration: true,
      status: true,
      chapter: {
        select: {
          id: true,
          title: true,

          lesson: {
            select: {
              id: true,
              title: true,
            },
            orderBy: {
              position: "asc",
            },
          },
        },
        orderBy: {
          position: "asc",
        },
      },
    },
  });
  if (!course) {
    return notFound();
  }
  return course;
}
