import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, QueryClientWrapper } from "../../lib/test-query-client";
import { EditorialCourseEditor } from "./EditorialCourseEditor";
import type { EditorialDocument, PublishedSnapshot } from "./editorial-model";

vi.mock("./LexicalField", () => ({ LexicalField: ({ label, readOnly }: { label: string; readOnly?: boolean }) =>
  <div data-testid="lexical-field" data-readonly={readOnly ? "true" : "false"}>{label}</div> }));

const response = (body: unknown, status = 200): Response => ({ ok: status >= 200 && status < 300,
  status, json: async () => body }) as Response;
const course = { courseRef: "course", productRef: "course:course", accessModel: "FREE" as const,
  withdrawn: false, withdrawnReason: null, withdrawnTermsRef: null, version: 1, offer: null, projection: null };
const document = (title: string): EditorialDocument => ({
  courseRef: "course", title, slug: "course", summary: "Summary", visibility: "UNLISTED",
  sections: [{ sectionRef: "section", title: "Section", position: 0, visibility: "LISTED" }],
  lessons: [{ lessonRef: "lesson", sectionRef: "section", title: "Lesson", slug: "lesson", position: 0,
    visibility: "LISTED", freePreview: false }],
});
const published = (): PublishedSnapshot => ({
  course: { course_ref: "course", version: 1, title: "Published", slug: "course", summary: "Summary",
    visibility: "UNLISTED", editorial_requested_visibility: "UNLISTED", editorial_restriction: "NONE",
    description_json: null, seo_json: null },
  sections: [{ section_ref: "section", title: "Section", position: 0, visibility: "LISTED" }],
  lessons: [{ lesson_ref: "lesson", section_ref: "section", title: "Lesson", slug: "lesson", position: 0,
    visibility: "LISTED", free_preview: 0, description_json: null, seo_json: null }],
});

describe("Control Room editorial course editor", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  const mount = async () => {
    const client = createTestQueryClient();
    const user = userEvent.setup();
    render(<EditorialCourseEditor courses={[course]} />,
      { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });
    await user.selectOptions(screen.getByLabelText("Курс для редакции"), "course");
    await screen.findByLabelText("Название курса");
    return user;
  };

  it("creates a draft then publishes the saved revision through the admin session", async () => {
    let draftReads = 0;
    let publishedVersion = 0;
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/draft") && !init?.method) {
        draftReads += 1;
        return draftReads === 1 ? response({ error: { code: "DRAFT_NOT_FOUND" } }, 404)
          : response({ courseRef: "course", revision: 1, document: document("Course"), updatedAt: "2026-10-13" });
      }
      if (path.endsWith("/published") && !init?.method) return publishedVersion
        ? response({ ...published(), course: { ...published().course, title: "Course" } })
        : response({ error: { code: "PUBLISHED_COURSE_NOT_FOUND" } }, 404);
      if (path.endsWith("/draft") && init?.method === "PUT") return response({ courseRef: "course", revision: 1 });
      if (path.endsWith("/publish") && init?.method === "POST") {
        publishedVersion = 1;
        return response({ courseRef: "course", version: 1, visibility: "UNLISTED", cacheInvalidation: "OK" });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    global.fetch = fetchMock;
    const user = await mount();
    await user.type(screen.getByLabelText("Название курса"), "Course");
    await user.type(screen.getByLabelText("Название раздела"), "Section");
    await user.type(screen.getByLabelText("Название урока"), "Lesson");
    await user.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    await screen.findByText(/Черновик сохранён/);
    const save = fetchMock.mock.calls.find(([url, options]) => String(url).endsWith("/draft") && options?.method === "PUT");
    expect(save?.[1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    const saved = JSON.parse(String(save?.[1]?.body)) as { expectedRevision: number; document: EditorialDocument };
    expect(saved.expectedRevision).toBe(0);
    expect(saved.document.sections[0].position).toBe(0);
    expect(saved.document.lessons[0].position).toBe(0);
    expect(saved.document.title).toBe("Course");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/catalogue/products"))).toBe(false);

    await user.click(screen.getByRole("button", { name: "Опубликовать" }));
    await screen.findByText(/Опубликована версия 1/);
    const publish = fetchMock.mock.calls.find(([url, options]) => String(url).endsWith("/publish") && options?.method === "POST");
    expect(JSON.parse(String(publish?.[1]?.body))).toMatchObject({ expectedRevision: 1,
      expectedPublishedVersion: 0, idempotencyKey: expect.any(String) });
  });

  it("keeps local changes after a CAS conflict until the operator explicitly refreshes", async () => {
    let draftReads = 0;
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/draft") && !init?.method) {
        draftReads += 1;
        return response({ courseRef: "course", revision: draftReads === 1 ? 1 : 2,
          document: document(draftReads === 1 ? "Initial" : "Remote"), updatedAt: "2026-10-13" });
      }
      if (path.endsWith("/published") && !init?.method) return response(published());
      if (path.endsWith("/draft") && init?.method === "PUT") return response({ error: { code: "DRAFT_REVISION_CONFLICT" } }, 409);
      throw new Error(`Unexpected request: ${path}`);
    });
    global.fetch = fetchMock;
    const user = await mount();
    const title = screen.getByLabelText("Название курса");
    await user.clear(title);
    await user.type(title, "Local");
    await user.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    await screen.findByText(/DRAFT_REVISION_CONFLICT/);
    expect(title).toHaveValue("Local");
    expect(draftReads).toBe(1);
    await user.click(screen.getByRole("button", { name: "Загрузить серверную версию" }));
    await waitFor(() => expect(title).toHaveValue("Remote"));
    expect(screen.getByText(/r2 · сохранён/)).toBeInTheDocument();
  });

  it.each(["draft", "published"] as const)("preserves unsaved edits after a failed %s background refetch", async (failedRead) => {
    const client = createTestQueryClient();
    const user = userEvent.setup();
    let failBackgroundRead = false;
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (failBackgroundRead && path.endsWith(`/${failedRead}`)) throw new Error("Connection closed");
      if (path.endsWith("/draft")) return response({ courseRef: "course", revision: 1,
        document: document("Server title"), updatedAt: "2026-10-13" });
      if (path.endsWith("/published")) return response(published());
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<EditorialCourseEditor courses={[course]} />,
      { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });
    await user.selectOptions(screen.getByLabelText("Курс для редакции"), "course");
    const title = await screen.findByLabelText("Название курса");
    await user.clear(title);
    await user.type(title, "Unsaved local title");
    expect(screen.getByText(/r1 · есть изменения/)).toBeInTheDocument();

    failBackgroundRead = true;
    await client.invalidateQueries({ queryKey: ["control-room-v2", `editorial-${failedRead}`, "course"] });
    expect(await screen.findByRole("alert")).toHaveTextContent("Несохранённые правки остаются в редакторе");
    expect(screen.getByLabelText("Название курса")).toBe(title);
    expect(title).toHaveValue("Unsaved local title");
    expect(screen.getByText(/r1 · есть изменения/)).toBeInTheDocument();

    failBackgroundRead = false;
    await client.invalidateQueries({ queryKey: ["control-room-v2", `editorial-${failedRead}`, "course"] });
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Название курса")).toBe(title);
    expect(title).toHaveValue("Unsaved local title");
  });

  it("shows a fatal read error when no initial course data was loaded", async () => {
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => String(input).endsWith("/draft")
      ? Promise.reject(new Error("Offline")) : response(published()));
    const client = createTestQueryClient();
    const user = userEvent.setup();
    render(<EditorialCourseEditor courses={[course]} />,
      { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });
    await user.selectOptions(screen.getByLabelText("Курс для редакции"), "course");
    expect(await screen.findByText(/NETWORK_AMBIGUOUS/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Название курса")).not.toBeInTheDocument();
  });

  it("shows a read-only publication and prevents duplicate draft submission", async () => {
    let resolveSave: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/draft") && !init?.method) return response({ courseRef: "course", revision: 1,
        document: document("Draft"), updatedAt: "2026-10-13" });
      if (path.endsWith("/published") && !init?.method) return response(published());
      if (path.endsWith("/draft") && init?.method === "PUT") return new Promise<Response>((resolve) => { resolveSave = resolve; });
      throw new Error(`Unexpected request: ${path}`);
    });
    global.fetch = fetchMock;
    const user = await mount();
    expect(screen.getByText(/Опубликованная версия v1/)).toBeInTheDocument();
    expect(screen.getByLabelText("Slug курса")).toBeDisabled();
    await user.type(screen.getByLabelText("Название курса"), " updated");
    const button = screen.getByRole("button", { name: "Сохранить черновик" });
    await user.click(button);
    await user.click(button);
    expect(fetchMock.mock.calls.filter(([url, options]) => String(url).endsWith("/draft") && options?.method === "PUT")).toHaveLength(1);
    resolveSave?.(response({ revision: 2 }));
    await screen.findByText(/Черновик сохранён/);
  });

  it("shows the saved course and lesson content in the published view", async () => {
    const saved = published();
    saved.course.description_json = JSON.stringify({ root: { type: "root", version: 1, children: [] } });
    saved.course.seo_json = JSON.stringify({ title: "Published SEO" });
    saved.lessons[0].description_json = JSON.stringify({ root: { type: "root", version: 1, children: [] } });
    saved.lessons[0].seo_json = JSON.stringify({ title: "Lesson SEO" });
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => String(input).endsWith("/draft")
      ? response({ courseRef: "course", revision: 1, document: document("Draft"), updatedAt: "2026-10-13" })
      : response(saved));
    const user = await mount();
    await user.click(screen.getByText(/Опубликованная версия v1/));
    expect(screen.getByText(/Published SEO/)).toBeInTheDocument();
    expect(screen.getByText(/Lesson SEO/)).toBeInTheDocument();
    expect(screen.getByText("Опубликованный текст курса")).toHaveAttribute("data-readonly", "true");
    expect(screen.getByText("Опубликованный текст урока Lesson")).toHaveAttribute("data-readonly", "true");
  });

  it("reuses the publication key after an ambiguous network response", async () => {
    let publishAttempts = 0;
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/draft") && !init?.method) return response({ courseRef: "course", revision: 1,
        document: document("Course"), updatedAt: "2026-10-13" });
      if (path.endsWith("/published") && !init?.method) return publishAttempts > 1
        ? response(published()) : response({ error: { code: "PUBLISHED_COURSE_NOT_FOUND" } }, 404);
      if (path.endsWith("/publish") && init?.method === "POST") {
        publishAttempts += 1;
        if (publishAttempts === 1) throw new Error("Connection closed");
        return response({ version: 1, visibility: "UNLISTED", cacheInvalidation: "OK" });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    global.fetch = fetchMock;
    const user = await mount();
    await user.click(screen.getByRole("button", { name: "Опубликовать" }));
    await screen.findByText(/NETWORK_AMBIGUOUS/);
    await user.click(screen.getByRole("button", { name: "Опубликовать" }));
    await screen.findByText(/Опубликована версия 1/);
    const bodies = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/publish") && init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)) as { idempotencyKey: string });
    expect(bodies).toHaveLength(2);
    expect(bodies[0].idempotencyKey).toBe(bodies[1].idempotencyKey);
  });
});
