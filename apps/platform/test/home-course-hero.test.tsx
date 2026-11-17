import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomeCourseHero from "../components/home/HomeCourseHero";
import type { OrbitCourse } from "../components/home/orbit-course";

const { connection, courseOrbit } = vi.hoisted(() => ({
  connection: vi.fn(async () => {}),
  courseOrbit: vi.fn(),
}));

vi.mock("next/server", async (original) => ({ ...await original<typeof import("next/server")>(), connection }));
vi.mock("../components/home/CourseOrbit", () => ({ default: courseOrbit }));

const entry = (number: number) => ({
  course: {
    slug: `course-${number}`,
    title: `Курс ${number}`,
    summary: `Описание ${number}`,
    description: { text: "Rich description" },
  },
  commercial: { offerRef: "not-for-homepage" },
});

describe("home course hero", () => {
  beforeEach(() => {
    vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "http://isolated-commerce:3002");
    courseOrbit.mockImplementation(({ courses, children }: { courses: OrbitCourse[]; children: ReactNode }) => (
      <>{children}<ol>{courses.map((course) => <li key={course.slug}><a href={course.href}>{course.title}</a></li>)}</ol></>
    ));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("features the first ten published courses with their own links and a link to the full catalogue", async () => {
    const entries = Array.from({ length: 11 }, (_, index) => entry(index + 1));
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ courses: entries }));

    const html = renderToStaticMarkup(await HomeCourseHero());

    expect(connection).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("http://isolated-commerce:3002/v1/courses");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
    expect(courseOrbit.mock.calls[0]?.[0].courses).toEqual(entries.slice(0, 10).map(({ course }) => ({
      slug: course.slug, title: course.title, summary: course.summary, href: `/courses/${course.slug}`,
    })));
    expect(html).toContain('href="/courses/course-1"');
    expect(html).toContain('href="/courses"');
  });

  it("keeps the homepage visible when Commerce stops listing a course", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ courses: [entry(1)] }))
      .mockResolvedValueOnce(Response.json({ courses: [] }));

    expect(renderToStaticMarkup(await HomeCourseHero())).toContain('href="/courses/course-1"');
    const html = renderToStaticMarkup(await HomeCourseHero());
    expect(html).toContain("Первый курс готовится к публикации.");
    expect(html).toContain('href="/courses"');
    expect(html).not.toContain("course-1");
    expect(courseOrbit).toHaveBeenCalledOnce();
  });

  it("keeps navigation and the hero available when Commerce is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));

    const html = renderToStaticMarkup(await HomeCourseHero());

    expect(html).toContain("Тело знает.");
    expect(html).toContain("Каталог временно недоступен.");
    expect(html).toContain('href="/courses"');
    expect(courseOrbit).not.toHaveBeenCalled();
  });
});
