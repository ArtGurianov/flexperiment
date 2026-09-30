"use client";
import React, { ReactNode, useState, useEffect } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  rectIntersection,
  DraggableSyntheticListeners,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Card } from "@/components/ui/card";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AdminCourseSingularType } from "@/app/data/admin/admin-get-course";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronUp, FileText, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { toast } from "sonner";
import { reorderChapters, reorderLesson } from "../editCourse";
import NewChapterModal from "./NewChapterModal";
import NewLessonModal from "./NewLessonModal";
import DeleteLesson from "./DeleteLesson";
import DeleteChapter from "./DeleteChapter";

interface iAppProps {
  data: AdminCourseSingularType;
}

interface SortableItemProps {
  id: string;
  children: (listeners: DraggableSyntheticListeners) => ReactNode;
  className?: string;
  data?: {
    type: "chapter" | "lesson";
    chapterId?: string;
  };
}

export function CourseStructure({ data }: iAppProps) {
  const initialItems =
    data.chapter.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      order: chapter.position,
      isOpen: true,
      lesson: chapter.lesson.map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        order: lesson.position,
      })),
    })) || [];

  const [items, setItems] = useState(initialItems);
  console.log(items);

  useEffect(() => {
    setItems((prevItems) => {
      const updatedItems =
        data.chapter.map((chapter) => ({
          id: chapter.id,
          title: chapter.title,
          order: chapter.position,
          isOpen: prevItems.find((item) => item.id === chapter.id)?.isOpen ?? true,
          lesson: chapter.lesson.map((lesson) => ({
            id: lesson.id,
            title: lesson.title,
            order: lesson.position,
          })),
        })) || [];
      return updatedItems;
    });
  }, [data]);

  function SortableItem({ children, id, className, data }: SortableItemProps) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
      id: id,
      data: data,
    });

    const style = {
      transform: CSS.Transform.toString(transform),
      transition,
    };

    return (
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        className={cn("touch-none", className, isDragging ? "z-10" : "")}
      >
        {children(listeners)}
      </div>
    );
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;

    if (!over || active.id === over.id) return;

    const activeId = active.id;
    const overId = over.id;
    const activeType = active.data.current?.type as "chapter" | "lesson";
    const overType = active.data.current?.type as "chapter" | "lesson";
    const courseId = data.id;

    if (activeType === "chapter") {
      let targetChapterId = null;
      if (overType === "chapter") {
        targetChapterId = overId;
      } else if (overType === "lesson") {
        targetChapterId = over.data.current?.chapterId ?? null;
      }
      if (!targetChapterId) {
        toast.error("Couldnot determine the chapter for reodering");
        return;
      }
      const oldIndex = items.findIndex((item) => item.id === activeId);
      const newIndex = items.findIndex((item) => item.id === targetChapterId);

      if (oldIndex === -1 || newIndex === -1) {
        toast.error("could not find chpater old/new index for reordering");
        return;
      }
      const reordedLocalChapters = arrayMove(items, oldIndex, newIndex);

      const updatedChapterforState = reordedLocalChapters.map((chapter, index) => ({
        ...chapter,
        order: index + 1,
      }));

      const previousItems = [...items];

      setItems(updatedChapterforState);

      if (courseId) {
        const chaptersToUpdate = updatedChapterforState.map((chapter) => ({
          id: chapter.id,
          position: chapter.order,
        }));

        const reorderChapterPromise = () => reorderChapters(courseId, chaptersToUpdate);
        toast.promise(reorderChapterPromise(), {
          loading: "Reordering Chapters",
          success: (result) => {
            if (result.status === "success") return result.message;
            throw new Error(result.message);
          },
          error: () => {
            setItems(previousItems);
            return "failed to reorder chapters";
          },
        });
      }
      return;
    }

    if (activeType === "lesson" || overType === "lesson") {
      const chapterId = active.data.current?.chapterId;
      const overChapterId = over.data.current?.chapterId;

      if (!chapterId || chapterId !== overChapterId) {
        return toast.error("lesson move between chapters or invalid chapters Id's are not allowed");
      }

      const chapterIndex = items.findIndex((chapter) => chapter.id === chapterId);
      if (chapterIndex === -1) {
        return toast.error("couldnot find chapter for lesson");
      }
      const chapterToUpdate = items[chapterIndex];

      const oldLessonIndex = chapterToUpdate.lesson.findIndex((lesson) => lesson.id === activeId);

      const newLessonIndex = chapterToUpdate.lesson.findIndex((lesson) => lesson.id === overId);
      if (oldLessonIndex === -1 || newLessonIndex === -1) {
        toast.error("could not find lesson old/new index for reordering");
        return;
      }

      const reorderedLesson = arrayMove(chapterToUpdate.lesson, oldLessonIndex, newLessonIndex);

      const updatedLessonForState = reorderedLesson.map((lesson, index) => ({
        ...lesson,
        order: index + 1,
      }));

      const newItems = [...items];

      newItems[chapterIndex] = {
        ...chapterToUpdate,
        lesson: updatedLessonForState,
      };

      const previousItems = [...items];
      setItems(newItems);

      if (courseId) {
        const lessonToUpdate = updatedLessonForState.map((lesson) => ({
          id: lesson.id,
          position: lesson.order,
        }));

        const reorderLessonPromise = () => reorderLesson(chapterId, lessonToUpdate, courseId);
        toast.promise(reorderLessonPromise(), {
          loading: "Reordering Lessons",
          success: (result) => {
            if (result.status === "success") return result.message;
            throw new Error(result.message);
          },
          error: () => {
            setItems(previousItems);
            return "failed to reorder lessons";
          },
        });
      }
      return;
    }
  }

  function toggleChapter(chapterId: string) {
    setItems(
      items.map((chapter) =>
        chapter.id === chapterId ? { ...chapter, isOpen: !chapter.isOpen } : chapter
      )
    );
  }

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  return (
    <DndContext sensors={sensors} collisionDetection={rectIntersection} onDragEnd={handleDragEnd}>
      <div className="space-y-6 w-full max-w-6xl mx-auto">
        {/* Header with Create Chapter Button */}
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-foreground">Course Structure</h2>
          <NewChapterModal courseId={data.id} />
        </div>

        <SortableContext items={items} strategy={verticalListSortingStrategy}>
          {items.map((chapter) => (
            <SortableItem key={chapter.id} id={chapter.id} data={{ type: "chapter" }}>
              {(listeners) => (
                <Card className="rounded-3xl shadow-lg border border-border overflow-hidden">
                  <Collapsible open={chapter.isOpen} onOpenChange={() => toggleChapter(chapter.id)}>
                    <div className="flex items-center justify-between p-4 border-b border-border bg-card">
                      <div className="flex items-center gap-3">
                        <Button
                          variant="ghost"
                          size="icon"
                          {...listeners}
                          className="cursor-grab hover:bg-muted/20"
                        >
                          <GripVertical className="w-5 h-5 text-muted-foreground" />
                        </Button>

                        <CollapsibleTrigger asChild>
                          <Button variant="ghost" size="icon" className="hover:bg-muted/20">
                            {chapter.isOpen ? (
                              <ChevronDown className="w-5 h-5 text-muted-foreground" />
                            ) : (
                              <ChevronUp className="w-5 h-5 text-muted-foreground" />
                            )}
                          </Button>
                        </CollapsibleTrigger>

                        <h3 className="text-lg font-semibold text-foreground">{chapter.title}</h3>
                      </div>
                      <DeleteChapter courseId={data.id} chapterId={chapter.id} />
                    </div>

                    <CollapsibleContent>
                      <div className="space-y-2 p-4">
                        <SortableContext
                          items={chapter.lesson.map((l) => l.id)}
                          strategy={verticalListSortingStrategy}
                        >
                          {chapter.lesson.map((lesson) => (
                            <SortableItem
                              key={lesson.id}
                              id={lesson.id}
                              data={{ type: "lesson", chapterId: chapter.id }}
                            >
                              {(lessonListeners) => (
                                <div className="flex items-center justify-between p-3 border border-muted/30 rounded-xl bg-card shadow-sm">
                                  <div className="flex items-center gap-3">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      {...lessonListeners}
                                      className="cursor-grab hover:bg-muted/20"
                                    >
                                      <GripVertical className="w-4 h-4 text-muted-foreground" />
                                    </Button>
                                    <FileText className="w-5 h-5 text-primary" />
                                    <Link
                                      href={`/admin/courses/${data.id}/${chapter.id}/${lesson.id}`}
                                      className="text-foreground font-medium hover:text-primary transition-colors"
                                    >
                                      {lesson.title}
                                    </Link>
                                  </div>
                                  <DeleteLesson
                                    courseId={data.id}
                                    chapterId={chapter.id}
                                    lessonId={lesson.id}
                                  />
                                </div>
                              )}
                            </SortableItem>
                          ))}
                        </SortableContext>

                        <NewLessonModal courseId={data.id} chapterId={chapter.id} />
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </Card>
              )}
            </SortableItem>
          ))}
        </SortableContext>
      </div>
    </DndContext>
  );
}
