import "server-only";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "./require-admin";

export async function adminGetCourse() {
  await requireAdmin();
  const data = await prisma.course.findMany({
    orderBy: {
      createdAt: "desc",
    },
    select: {
      id: true,
      title: true,
      smallDescription: true,
      fileKey: true,
      price: true,
      duration: true,
      level: true,
      status: true,
      slug: true,
    },
  });
  return data;
}

export type AdminCourseType = Awaited<ReturnType<typeof adminGetCourse>>[0];
