"use client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import React, { useTransition } from "react";
import { deleteCourse } from "./action";
import { toast } from "sonner";
import { tryCatch } from "@/hooks/try-catch";
import { useParams, useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";

const DeleteCourse = () => {
  const router = useRouter();
  const { courseId } = useParams<{ courseId: string }>();
  const [isPending, startTransition] = useTransition();

  const onSubmit = () => {
    startTransition(async () => {
      const { data: result, error } = await tryCatch(deleteCourse(courseId));
      if (error) {
        toast.error("Failed to delete course. Please try again.");
        return;
      }
      if (result.status === "success") {
        toast.success(result.message);
        router.push("/admin/courses");
      } else if (result.status === "error") {
        toast.error(result.message);
      }
    });
  };
  return (
    <div className="w-full max-w-lg mx-auto mt-12">
      <Card className="border-destructive/30 shadow-lg">
        <CardHeader>
          <CardTitle className="text-xl font-semibold text-destructive">Delete Course</CardTitle>
          <CardDescription>
            Are you sure you want to delete this course? <br />
            <span className="font-medium text-foreground">This action cannot be undone.</span>
          </CardDescription>
        </CardHeader>

        <CardContent className="flex justify-end gap-3">
          <Link href="/admin/courses">
            <Button variant="outline">Cancel</Button>
          </Link>
          <Button onClick={onSubmit} disabled={isPending} variant="destructive">
            {isPending ? (
              <>
                Deleting...
                <Loader2 className="animate-spin h-4 w-4" />
              </>
            ) : (
              <>
                <Trash2 />
                Delete Course
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};

export default DeleteCourse;
