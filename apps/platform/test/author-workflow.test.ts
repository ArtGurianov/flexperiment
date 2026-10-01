import { afterEach, describe, expect, it, vi } from "vitest";
import { courseCommercialEndpoints } from "../lib/course-commercial-endpoints";

const endpoint = (path: string) => {
  const found = courseCommercialEndpoints.find((candidate) => candidate.path === path);
  if (!found) throw new Error(`ENDPOINT_NOT_FOUND:${path}`);
  return found;
};

const author = { collection: "users", id: 1 };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Payload author workflow", () => {
  it("returns a course-specific Control Room deep link with the read-only summary", async () => {
    vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "https://commerce.internal");
    vi.stubEnv("PLATFORM_COMMERCE_SERVICE_TOKEN", "token");
    vi.stubEnv("ADMIN_ORIGIN", "https://admin.flexperiment.test");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      courses: [{ courseRef: "course:one", accessModel: "PAID" }],
    }));

    const response = await endpoint("/commercial-summary/:courseRef").handler({
      routeParams: { courseRef: "course:one" },
      user: author,
    } as never);

    expect(await response.json()).toMatchObject({
      accessModel: "PAID",
      controlRoomUrl: "https://admin.flexperiment.test/courses/?courseRef=course%3Aone",
    });
  });

  it("rejects a campaign for a course without a published version", async () => {
    vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "https://commerce.internal");
    vi.stubEnv("PLATFORM_COMMERCE_SERVICE_TOKEN", "token");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await endpoint("/campaigns/:courseRef").handler({
      json: async () => ({ subject: "Subject", message: "Message" }),
      payload: { find: vi.fn().mockResolvedValue({ docs: [] }) },
      routeParams: { courseRef: "course:one" },
      user: author,
    } as never);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "COURSE_NOT_PUBLISHED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("previews the published lessons through the authenticated campaign command", async () => {
    vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "https://commerce.internal");
    vi.stubEnv("PLATFORM_COMMERCE_SERVICE_TOKEN", "token");
    const find = vi.fn(async ({ collection }: { collection: string }) => {
      if (collection === "courses") return { docs: [{
        id: 7,
        courseRef: "course:one",
        title: "Курс",
        slug: "course",
        everPublished: true,
        manifestVersion: 3,
        publicContentUpdatedAt: "2026-10-01T06:00:00Z",
      }] };
      if (collection === "sections") return { docs: [{ id: 3, course: 7, sectionRef: "section:one", position: 0 }] };
      return { docs: [{
        id: 9,
        course: 7,
        section: 3,
        lessonRef: "lesson:one",
        title: "Первый урок",
        slug: "first",
        position: 0,
      }] };
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      id: "campaign-id",
      preview: { lessons: [{ lessonRef: "lesson:one", title: "Первый урок", slug: "first" }] },
    }, { status: 201 }));

    const response = await endpoint("/campaigns/:courseRef").handler({
      headers: new Headers({ "idempotency-key": "campaign:author-action" }),
      json: async () => ({ subject: "Subject", message: "Message" }),
      payload: { find },
      routeParams: { courseRef: "course:one" },
      user: author,
    } as never);

    expect(response.status).toBe(201);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      courseRef: "course:one",
      payload: {
        course: { title: "Курс", slug: "course", contentVersion: "2026-10-01T06:00:00Z" },
        lessons: [{ lessonRef: "lesson:one", title: "Первый урок", slug: "first" }],
      },
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ "idempotency-key": "campaign:author-action" });
  });
});
