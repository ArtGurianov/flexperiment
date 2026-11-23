import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIndexNowNotifier, INDEXNOW_ENDPOINT, indexNowPayload } from "../src/indexnow";

const KEY = "a1b2c3d4e5f60718";
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE catalog_course_projection (course_ref TEXT PRIMARY KEY, slug TEXT, version INTEGER, visibility TEXT);
    CREATE TABLE products (course_ref TEXT, kind TEXT, withdrawn_at TEXT);
    INSERT INTO catalog_course_projection VALUES ('course-one','one',1,'LISTED'),('course-draft',NULL,1,'UNLISTED');
    INSERT INTO products VALUES ('course-one','ONLINE_COURSE',NULL);
  `);
});

const enabled = { INDEXNOW_ENABLED: "true", INDEXNOW_KEY: KEY };
const notifier = (overrides: Partial<Parameters<typeof createIndexNowNotifier>[0]> = {}) => {
  const fetcher = vi.fn(async () => new Response(null, { status: 202 }));
  const log = vi.fn();
  let clock = 1_000_000;
  const notify = createIndexNowNotifier({ db, environment: enabled, deployEnvironment: "production",
    platformOrigin: "https://flexperiment.ru", fetcher: fetcher as unknown as typeof fetch, log,
    now: () => clock, ...overrides });
  return { notify, fetcher, log, advance: (ms: number) => { clock += ms; } };
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("IndexNow notifier", () => {
  it.each([
    ["disabled by default", { environment: { INDEXNOW_KEY: KEY } }],
    ["enabled outside production", { deployEnvironment: "staging" }],
    ["missing key", { environment: { INDEXNOW_ENABLED: "true" } }],
    ["malformed key", { environment: { INDEXNOW_ENABLED: "true", INDEXNOW_KEY: "bad key!" } }],
    ["non-https platform origin", { platformOrigin: "http://127.0.0.1:3101" }],
  ])("stays off when %s", (_name, overrides) => {
    expect(notifier(overrides as never).notify).toBeUndefined();
  });

  it("sends one canonical course URL per course within the dedupe window", async () => {
    const { notify, fetcher, advance } = notifier();
    notify!("course-one");
    notify!("course-one");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(INDEXNOW_ENDPOINT);
    expect(JSON.parse(String(init.body))).toEqual({
      host: "flexperiment.ru", key: KEY, keyLocation: "https://flexperiment.ru/indexnow-key.txt",
      urlList: ["https://flexperiment.ru/courses/one"],
    });
    await flush();
    advance(10 * 60_000 + 1);
    notify!("course-one");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("submits publish, unlist, relist and withdrawal inside one dedupe window", () => {
    const { notify, fetcher } = notifier();
    notify!("course-one");
    db.exec("UPDATE catalog_course_projection SET version=2,visibility='UNLISTED' WHERE course_ref='course-one'");
    notify!("course-one");
    db.exec("UPDATE catalog_course_projection SET version=3,visibility='LISTED' WHERE course_ref='course-one'");
    notify!("course-one");
    db.exec("UPDATE products SET withdrawn_at='2026-11-23T00:00:00Z' WHERE course_ref='course-one'");
    notify!("course-one");
    notify!("course-one");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([429, 500])("records HTTP %s as a failure and accepts a later notification for that state", async (status) => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const { notify, log } = notifier({ fetcher });
    notify!("course-one");
    await flush();
    expect(log.mock.calls).toEqual([[{ event: "indexnow.failed", courseRef: "course-one", status }]]);
    notify!("course-one");
    await flush();
    expect(log).toHaveBeenLastCalledWith({ event: "indexnow.sent", courseRef: "course-one", status: 202 });
  });

  it("ignores unknown, slugless or absent courses", async () => {
    const { notify, fetcher } = notifier();
    notify!("");
    notify!("missing");
    notify!("course-draft");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never blocks or fails the owner command when IndexNow is slow or down", async () => {
    let release!: () => void;
    const hanging = vi.fn(() => new Promise<Response>((_resolve, reject) => { release = () => reject(new Error("down")); }));
    const { notify, log } = notifier({ fetcher: hanging as unknown as typeof fetch });
    expect(notify!("course-one")).toBeUndefined();
    release();
    await flush();
    expect(log).toHaveBeenCalledWith({ event: "indexnow.failed", courseRef: "course-one" });
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
  });

  it("builds payloads only for safe slugs on an https origin", () => {
    expect(indexNowPayload("https://flexperiment.ru", KEY, ["one", "one", "../admin", "Two"])!.urlList)
      .toEqual(["https://flexperiment.ru/courses/one"]);
    expect(indexNowPayload("http://flexperiment.ru", KEY, ["one"])).toBeNull();
    expect(indexNowPayload("https://flexperiment.ru", KEY, [])).toBeNull();
  });
});
