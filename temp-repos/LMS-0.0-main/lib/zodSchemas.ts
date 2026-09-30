import { z } from "zod";

export const courseCategories = [
  "Web Development",
  "Data Science",
  "Mobile Development",
  "Game Development",
  "Artificial Intelligence",
  "Machine Learning",
  "Cloud Computing",
  "Cybersecurity",
  "DevOps",
  "UI/UX Design",
  "Digital Marketing",
  "Business Analysis",
  "Project Management",
  "Software Testing",
  "Blockchain",
  "Finance",
  "Backend Development",
] as const;

export const courseLevel = ["BEGINNER", "INTERMEDIATE", "ADVANCED"] as const;
export const courseStatus = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;

export const courseSchema = z.object({
  title: z
    .string()
    .min(5, "Title must be at least 5 characters long")
    .max(100, "Title must be at most 100 characters long"),
  description: z.string().min(10, "Description must be at least 10 characters long"),
  fileKey: z.string().min(1, "File key is required"),
  price: z.coerce.number().min(1, "Price must be a positive number"),
  duration: z.coerce.number().min(1, "Duration is required").max(500, "Duration seems too long"),
  level: z.enum(courseLevel, "level must be one of BEGINNER, INTERMEDIATE, ADVANCED"),
  category: z.enum(courseCategories, "category must be one of the predefined categories"),
  smallDescription: z
    .string()
    .min(5, "Small description must be at least 5 characters long")
    .max(100, "Small description must be at most 100 characters long"),
  slug: z.string().min(5, "Slug must be at least 5 characters long"),
  status: z
    .enum(courseStatus, "status must be one of DRAFT, PUBLISHED, ARCHIVED")
    .optional()
    .default("DRAFT"),
});

export const chapterSchema = z.object({
  name: z.string().min(3, "Name must be atleast three characters"),
  courseId: z.uuid({ message: "invalid course id" }),
});

export const lessonSchema = z.object({
  name: z.string().min(3, "Name must be atleast 3 characters"),
  courseId: z.uuid({ message: "invalid course id" }),
  chapterId: z.uuid({ message: "invalid chapter id" }),
  description: z.string().min(3, "description must be atleast 3 characters long").optional(),
  thumbnailKey: z.string().optional(),
  videoKey: z.string().optional(),
});

export type CourseSchemaType = z.infer<typeof courseSchema>;
export type chapterSchemaType = z.infer<typeof chapterSchema>;
export type lessonSchemaType = z.infer<typeof lessonSchema>;
