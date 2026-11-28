// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FreeEnrollmentAction from "../components/courses/FreeEnrollmentAction";
import FreeEnrollmentContinuation from "../components/auth/FreeEnrollmentContinuation";
import MarketingPreference from "../components/auth/MarketingPreference";
import LessonPlayer from "../components/kinescope/LessonPlayer";
import { consumeEnrollmentIntent, enrollmentAccountPath, navigation, parseEnrollmentIntent, rememberEnrollmentIntent } from "../components/courses/freeEnrollment";
import { loadIframeApi } from "../components/kinescope/iframeApi";

vi.mock("../components/kinescope/iframeApi", () => ({ loadIframeApi: vi.fn() }));

const json = (body: unknown, status = 200) => Response.json(body, { status });
const status = (overrides = {}) => ({ courseRef: "free", courseSlug: "free", courseTitle: "Бесплатный курс", accessModel: "FREE",
  enrollment: null, enrollable: true, ...overrides });
const enrolled = { courseRef: "free", courseSlug: "free", enrolledAt: "2026-11-20T10:00:00.000Z", startedAt: "2026-11-20T10:00:00.000Z",
  progressPercent: 0, created: true, lessonPath: "/courses/free/lessons/one" };
const posts = () => vi.mocked(global.fetch).mock.calls.filter(([, init]) => init?.method === "POST");

describe("FLEX-128 enrollment UI", () => {
  const originalFetch = global.fetch;
  let assign: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { window.localStorage.clear(); assign = vi.spyOn(navigation, "assign").mockImplementation(() => undefined); });
  afterEach(() => { cleanup(); global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("carries a guest's explicit click and chosen lesson through the login without enrolling", async () => {
    global.fetch = vi.fn(async () => json({ code: "SIGN_IN_REQUIRED" }, 401));
    render(<FreeEnrollmentAction courseSlug="free" lessonSlug="two" accessModel="FREE" />);
    fireEvent.click(await screen.findByRole("button", { name: "Записаться бесплатно →" }));
    expect(assign).toHaveBeenCalledWith("/account?enroll=free&lesson=two");
    expect(posts()).toHaveLength(0);
    expect(consumeEnrollmentIntent({ courseSlug: "free", lessonSlug: "two" })).toBe(true);
  });

  it("enrolls a signed-in account once per click and opens the lesson the server returned", async () => {
    global.fetch = vi.fn(async (_input, init) => init?.method === "POST" ? json(enrolled, 201) : json(status()));
    render(<FreeEnrollmentAction courseSlug="free" accessModel="FREE" />);
    const button = await screen.findByRole("button", { name: "Записаться бесплатно →" });
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/courses/free/lessons/one"));
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0]![1]!.body))).toEqual({ courseSlug: "free" });
  });

  it("never navigates to a lesson path outside the course routes", async () => {
    global.fetch = vi.fn(async (_input, init) => init?.method === "POST" ? json({ ...enrolled, lessonPath: "https://evil.example/x" }) : json(status()));
    render(<FreeEnrollmentAction courseSlug="free" accessModel="FREE" />);
    fireEvent.click(await screen.findByRole("button", { name: "Записаться бесплатно →" }));
    expect(await screen.findByText(/Повторное нажатие безопасно/)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it("shows retained enrollment and offers nothing to a guest on a paid course", async () => {
    global.fetch = vi.fn(async () => json(status({ accessModel: "PAID", enrollable: false, enrollment: enrolled })));
    render(<FreeEnrollmentAction courseSlug="free" accessModel="PAID" />);
    expect(await screen.findByText("Вы записаны")).toBeInTheDocument();
    expect(screen.getByText(/доступ сохранён/)).toBeInTheDocument();
    cleanup();
    global.fetch = vi.fn(async () => json({ code: "SIGN_IN_REQUIRED" }, 401));
    const { container } = render(<FreeEnrollmentAction courseSlug="paid" accessModel="PAID" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("completes the enrollment after login only for this browser's own fresh click", async () => {
    global.fetch = vi.fn(async (_input, init) => init?.method === "POST" ? json({ ...enrolled, lessonPath: "/courses/free/lessons/two" }, 201) : json(status()));
    rememberEnrollmentIntent({ courseSlug: "free", lessonSlug: "two" });
    render(<FreeEnrollmentContinuation intent={{ courseSlug: "free", lessonSlug: "two" }} />);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/courses/free/lessons/two"));
    expect(posts()).toHaveLength(1);
  });

  it("asks for an explicit confirmation when the account link arrives without this browser's click", async () => {
    global.fetch = vi.fn(async (_input, init) => init?.method === "POST" ? json(enrolled, 201) : json(status()));
    rememberEnrollmentIntent({ courseSlug: "other" }, Date.now());
    render(<FreeEnrollmentContinuation intent={{ courseSlug: "free" }} />);
    const button = await screen.findByRole("button", { name: "Записаться бесплатно →" });
    expect(screen.getByRole("heading", { name: "Записаться бесплатно на «Бесплатный курс»" })).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
    fireEvent.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/courses/free/lessons/one"));
  });

  it("preserves the browser intent when the first status read after login fails", async () => {
    global.fetch = vi.fn<typeof fetch>().mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json(status())).mockResolvedValueOnce(json({ ...enrolled, lessonPath: "/courses/free/lessons/two" }, 201));
    rememberEnrollmentIntent({ courseSlug: "free", lessonSlug: "two" });
    render(<FreeEnrollmentContinuation intent={{ courseSlug: "free", lessonSlug: "two" }} />);
    const retry = await screen.findByRole("button", { name: "Повторить проверку" });
    expect(posts()).toHaveLength(0);
    fireEvent.click(retry);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/courses/free/lessons/two"));
    expect(posts()).toHaveLength(1);
    expect(consumeEnrollmentIntent({ courseSlug: "free", lessonSlug: "two" })).toBe(false);
  });

  it("does not auto-enroll from a stale click", () => {
    rememberEnrollmentIntent({ courseSlug: "free" }, Date.now() - 3 * 60 * 60 * 1000);
    expect(consumeEnrollmentIntent({ courseSlug: "free" })).toBe(false);
    expect(parseEnrollmentIntent("free", "../x")).toEqual({ courseSlug: "free" });
    expect(parseEnrollmentIntent("javascript:alert(1)", "one")).toBeNull();
    expect(enrollmentAccountPath({ courseSlug: "free", lessonSlug: "one" })).toBe("/account?enroll=free&lesson=one");
  });

  it("gates a FREE lesson on ENROLLMENT_REQUIRED and re-requests the grant after enrolling in place", async () => {
    const create = vi.fn(async () => ({ Events: {}, on: vi.fn(), getCurrentTime: vi.fn(async () => 0), seekTo: vi.fn(), play: vi.fn(), destroy: vi.fn(async () => undefined) }));
    vi.mocked(loadIframeApi).mockResolvedValue({ create } as never);
    let enrolledNow = false;
    global.fetch = vi.fn(async (input, init) => {
      const path = String(input);
      if (path === "/v1/me/free-enrollments") { enrolledNow = true; return json(enrolled, 201); }
      if (path.startsWith("/v1/me/free-enrollments/")) return json(status());
      if (path.endsWith("/playback")) return enrolledNow ? json({ mode: "open", videoId: "video", resumeAt: 0 }) : json({ decision: "ENROLLMENT_REQUIRED" }, 403);
      void init; return json({});
    });
    render(<LessonPlayer lessonRef="free-l2" title="Two" enrollment={{ courseSlug: "free", lessonSlug: "two", accessModel: "FREE" }} />);
    expect(await screen.findByText("Чтобы открыть урок, запишитесь на бесплатный курс.")).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Записаться бесплатно →" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(assign).not.toHaveBeenCalled();
    expect(JSON.parse(String(posts().find(([input]) => String(input) === "/v1/me/free-enrollments")![1]!.body)))
      .toEqual({ courseSlug: "free", lessonSlug: "two" });
  });

  it("offers a FREE-course guest the enrollment instead of a bare login", async () => {
    global.fetch = vi.fn(async () => json({ code: "SIGN_IN_REQUIRED" }, 401));
    render(<LessonPlayer lessonRef="free-l2" title="Two" enrollment={{ courseSlug: "free", lessonSlug: "two", accessModel: "FREE" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Записаться бесплатно →" }));
    expect(assign).toHaveBeenCalledWith("/account?enroll=free&lesson=two");
    expect(screen.getByRole("link", { name: "Уже записаны? Войти" })).toHaveAttribute("href", expect.stringContaining("/account?next="));
  });

  it("rechecks the playback grant without enrolling again when another tab has enrolled", async () => {
    const create = vi.fn(async () => ({ Events: {}, on: vi.fn(), getCurrentTime: vi.fn(async () => 0), seekTo: vi.fn(), play: vi.fn(), destroy: vi.fn(async () => undefined) }));
    vi.mocked(loadIframeApi).mockResolvedValue({ create } as never);
    let playbackReads = 0;
    global.fetch = vi.fn(async input => {
      if (String(input).endsWith("/playback")) {
        return ++playbackReads === 1 ? json({ decision: "ENROLLMENT_REQUIRED" }, 403)
          : json({ mode: "open", videoId: "video", resumeAt: 0 });
      }
      return json(status({ enrollment: enrolled, enrollable: false }));
    });
    render(<LessonPlayer lessonRef="free-l2" title="Two" enrollment={{ courseSlug: "free", lessonSlug: "two", accessModel: "FREE" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Проверить доступ" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(playbackReads).toBe(2);
    expect(posts().filter(([input]) => String(input) === "/v1/me/free-enrollments")).toHaveLength(0);
  });

  it("offers to retry a transient status failure without enrolling", async () => {
    global.fetch = vi.fn<typeof fetch>().mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json(status()));
    render(<FreeEnrollmentAction courseSlug="free" accessModel="FREE" />);
    fireEvent.click(await screen.findByRole("button", { name: "Повторить проверку" }));
    expect(await screen.findByRole("button", { name: "Записаться бесплатно →" })).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it("switches marketing off with one sequenced action confirmed by read-back", async () => {
    const consent = (marketing: boolean, sequence: number, action?: object) => ({ storefront: "COURSES", verifiedAccount: true,
      requiredChoicesConfirmed: true, releaseVersion: "r1", manifestSha256: "a".repeat(64), actionSequence: sequence,
      choices: { personal_data: true, account_terms: true, marketing_consent: marketing }, documents: [{ kind: "marketing_consent", url: "/legal/m" }],
      ...(action ? { action } : {}) });
    let posted: Record<string, unknown> | null = null;
    global.fetch = vi.fn(async (input, init) => {
      if (init?.method === "POST") { expect(String(input)).toBe("/v1/me/consents/marketing"); posted = JSON.parse(String(init.body)); return json({}); }
      const key = new URL(String(input), "http://x").searchParams.get("actionKey");
      return posted ? json(consent(false, 2, { key, outcome: "COMMITTED" })) : json(consent(true, 1));
    });
    render(<MarketingPreference />);
    fireEvent.click(await screen.findByRole("button", { name: "Отозвать согласие на рассылку" }));
    expect(await screen.findByText("Согласие на рекламную рассылку отозвано.")).toBeInTheDocument();
    // G-18: only the marketing choice is sent; required choices are never re-recorded from here.
    expect(posted).toEqual({ storefront: "COURSES", releaseVersion: "r1", manifestSha256: "a".repeat(64),
      actionKey: expect.any(String), expectedActionSequence: 1, marketingConsent: false });
    expect(screen.getByRole("button", { name: "Дать согласие на рассылку" })).toBeInTheDocument();
  });

  it("confirms the saved marketing choice without asserting that mail will be delivered", async () => {
    const consent = { storefront: "COURSES", verifiedAccount: true, requiredChoicesConfirmed: true,
      releaseVersion: "r1", manifestSha256: "a".repeat(64), actionSequence: 1, documents: [] };
    global.fetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ ...consent, choices: { marketing_consent: false } }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ ...consent, actionSequence: 2, action: { outcome: "COMMITTED" },
        choices: { marketing_consent: true } }));
    render(<MarketingPreference />);
    fireEvent.click(await screen.findByRole("button", { name: "Дать согласие на рассылку" }));
    expect(await screen.findByText("Согласие на рекламную рассылку сохранено.")).toBeInTheDocument();
    expect(screen.queryByText(/Вы получаете|Рассылка включена/)).not.toBeInTheDocument();
  });
});
