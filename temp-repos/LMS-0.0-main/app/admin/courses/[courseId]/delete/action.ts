"use server";

import { requireAdmin } from "@/app/data/admin/require-admin";
import arcjet, { fixedWindow } from "@/lib/arcjet";
import { prisma } from "@/lib/prisma";
import { ApiResponse } from "@/lib/types";
import { request } from "@arcjet/next";
import { revalidatePath } from "next/cache";

const aj = arcjet.withRule(
  fixedWindow({
    mode: "LIVE",
    window: "1m",
    max: 5, // limit to 5 requests per minute
  })
);

export async function deleteCourse(courseId: string): Promise<ApiResponse> {
  const session = await requireAdmin();
  try {
    const req = await request();
    const decision = await aj.protect(req, {
      fingerprint: session?.user.id as string,
    });

    if (decision.isDenied()) {
      if (decision.reason.isRateLimit()) {
        return {
          status: "error",
          message: "Too many requests. Please try again later.",
        };
      } else {
        return {
          status: "error",
          message: "Request denied.",
        };
      }
    }
    await prisma.course.delete({
      where: { id: courseId },
    });
    revalidatePath("/admin/courses");
    return {
      status: "success",
      message: "Course deleted successfully.",
    };
  } catch (error) {
    return {
      status: "error",
      message: "There was an error deleting the course.",
    };
  }
}
