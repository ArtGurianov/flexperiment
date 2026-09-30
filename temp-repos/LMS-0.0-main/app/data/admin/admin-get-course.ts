import "server-only";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "./require-admin";

export async function adminGetCourse(id: string) {
  await requireAdmin();

  const data = await prisma.course.findUnique({
    where: { id: id },
    select: {
      id: true,
      description: true,
      title: true,
      fileKey: true,
      price: true,
      duration: true,
      level: true,
      slug: true,
      smallDescription: true,
      category: true,
      status: true,
      chapter: {
        select: {
          id: true,
          title: true,
          position: true,
          lesson: {
            select: {
              id: true,
              title: true,
              description: true,
              position: true,
              thumbnailKey: true,
              videoKey: true,
            },
          },
        },
      },
    },
  });

  if (!data) {
    throw new Error("Course not found");
  }

  return data;
}

export type AdminCourseSingularType = Awaited<ReturnType<typeof adminGetCourse>>;
