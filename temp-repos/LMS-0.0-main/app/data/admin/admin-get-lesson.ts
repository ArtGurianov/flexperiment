import "server-only";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "./require-admin";
import { notFound } from "next/navigation";

export default async function adminGetLesson(id: string) {
  await requireAdmin();
  const data = await prisma.lesson.findUnique({
    where: {
      id: id,
    },
    select: {
      id: true,
      description: true,
      videoKey: true,
      thumbnailKey: true,
      title: true,
      position: true,
    },
  });
  if (!data) {
    return notFound();
  }
  return data;
}

export type AdminLessonType = Awaited<ReturnType<typeof adminGetLesson>>;
