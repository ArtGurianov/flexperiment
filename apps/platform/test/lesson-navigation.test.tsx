// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import LessonNavigation from "../components/courses/LessonNavigation";

const lessons = [
  { lessonRef: "first", slug: "first", title: "Первый" },
  { lessonRef: "second", slug: "second", title: "Второй" },
  { lessonRef: "third", slug: "third", title: "Третий" },
];

describe("LessonNavigation", () => {
  afterEach(cleanup);

  it("links the previous and next lesson in course order", () => {
    render(<LessonNavigation courseSlug="course" currentLessonRef="second" lessons={lessons} />);
    expect(screen.getByRole("link", { name: /Предыдущий урок.*Первый/ })).toHaveAttribute("href", "/courses/course/lessons/first");
    expect(screen.getByRole("link", { name: /Следующий урок.*Третий/ })).toHaveAttribute("href", "/courses/course/lessons/third");
    expect(screen.getByRole("link", { name: "Все уроки" })).toHaveAttribute("href", "/courses/course");
  });

  it("does not wrap past the first or last lesson", () => {
    const { rerender } = render(<LessonNavigation courseSlug="course" currentLessonRef="first" lessons={lessons} />);
    expect(screen.queryByText("Предыдущий урок")).not.toBeInTheDocument();
    rerender(<LessonNavigation courseSlug="course" currentLessonRef="third" lessons={lessons} />);
    expect(screen.queryByText("Следующий урок →")).not.toBeInTheDocument();
  });
});
