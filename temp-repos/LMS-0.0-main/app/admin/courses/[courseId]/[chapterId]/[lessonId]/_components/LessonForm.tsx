"use client";

import { AdminLessonType } from "@/app/data/admin/admin-get-lesson";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { lessonSchema, lessonSchemaType } from "@/lib/zodSchemas";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, Loader2 } from "lucide-react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import TextEditor from "@/components/rich-text-editor/TextEditor";
import Uploader from "@/components/file-uploader/Uploader";
import { useTransition } from "react";
import { tryCatch } from "@/hooks/try-catch";
import { updateLesson } from "../actions";
import { toast } from "sonner";

interface iAppProps {
  data: AdminLessonType;
  chapterId: string;
  courseId: string;
}

const LessonForm = ({ chapterId, data, courseId }: iAppProps) => {
  const [isPending, startTransition] = useTransition();

  const form = useForm<lessonSchemaType>({
    resolver: zodResolver(lessonSchema),
    defaultValues: {
      name: data.title,
      courseId: courseId,
      chapterId: chapterId,
      description: data.description || undefined,
      videoKey: data.videoKey || undefined,
      thumbnailKey: data.thumbnailKey || undefined,
    },
  });

  const onSubmit = (values: lessonSchemaType) => {
    startTransition(async () => {
      const { data: result, error } = await tryCatch(updateLesson(values, data.id));
      if (error) {
        toast.error("Failed to update Lesson. Please try again.");
        return;
      }
      if (result.status === "success") {
        toast.success(result.message);
      } else if (result.status === "error") {
        toast.error(result.message);
      }
    });
  };

  return (
    <div>
      {/* Back button (keep as you had it) */}
      <Button asChild variant="outline" size="sm" className="shadow-sm mb-6">
        <Link href={`/admin/courses/${courseId}/edit`}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back
        </Link>
      </Button>

      <Card>
        <CardHeader className="border-b pb-4 mb-4">
          <div className="flex items-center gap-2">
            {/* Optional: Lesson icon */}
            <span className="p-2 rounded-md bg-primary/10 text-primary">📘</span>
            <div>
              <CardTitle className="text-xl font-semibold tracking-tight">
                Lesson Configuration
              </CardTitle>
              <CardDescription className="text-sm text-muted-foreground mt-1">
                Configure the video, thumbnail, and description for this lesson.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              {/* Lesson Name */}
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Lesson Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Enter lesson name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Description */}
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <TextEditor field={field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Thumbnail */}
              <FormField
                control={form.control}
                name="thumbnailKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Thumbnail Image</FormLabel>
                    <FormControl>
                      <Uploader
                        onChange={field.onChange}
                        value={field.value ?? ""}
                        fileTypeAccepted="image"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Video */}
              <FormField
                control={form.control}
                name="videoKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Video File</FormLabel>
                    <FormControl>
                      <Uploader
                        onChange={field.onChange}
                        value={field.value ?? ""}
                        fileTypeAccepted="video"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Submit Button */}
              <div className="pt-2">
                <Button
                  type="submit"
                  className="w-full flex items-center justify-center gap-2"
                  disabled={isPending}
                >
                  {isPending ? (
                    <>
                      Saving...
                      <Loader2 className="animate-spin h-4 w-4" />
                    </>
                  ) : (
                    <>Save Lesson</>
                  )}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
};

export default LessonForm;
