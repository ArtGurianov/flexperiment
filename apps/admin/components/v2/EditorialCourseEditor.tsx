"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { CatalogueResponse } from "../../lib/control-room-contracts";
import { api, AdminApiError, idempotencyKey } from "../../lib/api";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { LexicalField } from "./LexicalField";
import {
  blankEditorialDocument, documentFromPublished, newLesson, newSection, normalizedEditorialDocument,
  type EditorialDocument, type EditorialDraft, type EditorialLesson, type EditorialSection,
  type PublishedSnapshot, type Visibility,
} from "./editorial-model";

type Course = CatalogueResponse["courses"][number];
type EditorState = { document: EditorialDocument; revision: number; publishedVersion: number; dirty: boolean; seed: number };
type PublicationResult = { version: number; visibility: Visibility; cacheInvalidation: "OK" | "FAILED" };

async function optionalRead<T>(path: string): Promise<T | null> {
  try { return await api<T>(path); }
  catch (error) { if (error instanceof AdminApiError && error.status === 404) return null; throw error; }
}

function move<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (target < 0 || target >= items.length) return items;
  const reordered = [...items];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  return reordered;
}

function EditorialSession({ course }: { course: Course }) {
  const courseRef = course.courseRef;
  const draft = useQuery({ queryKey: ["control-room-v2", "editorial-draft", courseRef],
    queryFn: () => optionalRead<EditorialDraft>(`/v2/courses/${encodeURIComponent(courseRef)}/draft`) });
  const published = useQuery({ queryKey: ["control-room-v2", "editorial-published", courseRef],
    queryFn: () => optionalRead<PublishedSnapshot>(`/v2/courses/${encodeURIComponent(courseRef)}/published`) });
  if (draft.error || published.error) return <Notice error={draft.error instanceof AdminApiError ? draft.error.code
    : published.error instanceof AdminApiError ? published.error.code : "EDITORIAL_READ_FAILED"} />;
  if (draft.isPending || published.isPending) return <Loading />;
  const refreshRemote = async () => {
    const [freshDraft, freshPublished] = await Promise.all([draft.refetch(), published.refetch()]);
    if (freshDraft.error) throw freshDraft.error;
    if (freshPublished.error) throw freshPublished.error;
    return { draft: freshDraft.data ?? null, published: freshPublished.data ?? null };
  };
  return <LoadedEditorialSession course={course} initialDraft={draft.data ?? null}
    initialPublished={published.data ?? null} published={published.data ?? null} refreshRemote={refreshRemote} />;
}

function LoadedEditorialSession({ course, initialDraft, initialPublished, published, refreshRemote }: {
  course: Course; initialDraft: EditorialDraft | null; initialPublished: PublishedSnapshot | null;
  published: PublishedSnapshot | null;
  refreshRemote: () => Promise<{ draft: EditorialDraft | null; published: PublishedSnapshot | null }>;
}) {
  const courseRef = course.courseRef;
  const client = useQueryClient();
  const [state, setState] = useState<EditorState | null>(() => ({
    document: initialDraft?.document ?? (initialPublished ? documentFromPublished(initialPublished) : blankEditorialDocument(courseRef)),
    revision: initialDraft?.revision ?? 0, publishedVersion: initialPublished?.course.version ?? 0, dirty: false, seed: 0,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [relistReason, setRelistReason] = useState("");
  const actionLock = useRef(false);
  const keys = useRef<{ publish?: string; unlist?: string; relist?: string }>({});

  const update = (change: (document: EditorialDocument) => EditorialDocument) => {
    setState((previous) => previous ? { ...previous, document: change(previous.document), dirty: true } : previous);
    keys.current.publish = undefined;
    setNotice("");
  };
  const run = async (action: () => Promise<void>) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    try { await action(); }
    catch (failure) { setError(failure instanceof AdminApiError ? failure.code : "NETWORK_AMBIGUOUS"); }
    finally { actionLock.current = false; setBusy(false); }
  };
  const refresh = () => void run(async () => {
    const fresh = await refreshRemote();
    setState((previous) => ({ document: fresh.draft?.document
      ?? (fresh.published ? documentFromPublished(fresh.published) : blankEditorialDocument(courseRef)),
      revision: fresh.draft?.revision ?? 0, publishedVersion: fresh.published?.course.version ?? 0,
      dirty: false, seed: (previous?.seed ?? 0) + 1 }));
    keys.current = {};
    setNotice("Загружена актуальная версия с сервера.");
  });
  const save = () => {
    if (!state) return;
    void run(async () => {
      const document = normalizedEditorialDocument(state.document);
      const before = JSON.stringify(state.document);
      const result = await api<{ revision: number }>(`/v2/courses/${encodeURIComponent(courseRef)}/draft`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ document, expectedRevision: state.revision }),
      });
      setState((previous) => previous ? { ...previous, revision: result.revision,
        document: JSON.stringify(previous.document) === before ? document : previous.document,
        dirty: JSON.stringify(previous.document) !== before } : previous);
      keys.current.publish = undefined;
      await client.invalidateQueries({ queryKey: ["control-room-v2", "editorial-draft", courseRef] });
      setNotice(`Черновик сохранён · ревизия ${result.revision}.`);
    });
  };
  const publish = () => {
    if (!state || state.dirty || state.revision === 0) return;
    void run(async () => {
      const key = keys.current.publish ??= idempotencyKey();
      const result = await api<PublicationResult>(`/v2/courses/${encodeURIComponent(courseRef)}/publish`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: state.revision, expectedPublishedVersion: state.publishedVersion,
          idempotencyKey: key }),
      });
      setState((previous) => previous ? { ...previous, publishedVersion: result.version } : previous);
      keys.current.publish = undefined;
      await Promise.all([
        client.invalidateQueries({ queryKey: ["control-room-v2", "editorial-published", courseRef] }),
        client.invalidateQueries({ queryKey: ["control-room-v2", "catalogue"] }),
      ]);
      setNotice(result.cacheInvalidation === "OK" ? `Опубликована версия ${result.version}.`
        : `Версия ${result.version} опубликована; сброс кеша требует проверки.`);
    });
  };
  const restrict = (kind: "unlist" | "relist") => {
    if (!state || state.publishedVersion === 0 || kind === "relist" && !relistReason.trim()) return;
    void run(async () => {
      const key = keys.current[kind] ??= idempotencyKey();
      const result = await api<PublicationResult>(`/v2/courses/${encodeURIComponent(courseRef)}/${kind}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedPublishedVersion: state.publishedVersion, idempotencyKey: key,
          ...(kind === "relist" ? { reason: relistReason.trim() } : {}) }),
      });
      setState((previous) => previous ? { ...previous, publishedVersion: result.version } : previous);
      keys.current[kind] = undefined;
      await Promise.all([
        client.invalidateQueries({ queryKey: ["control-room-v2", "editorial-published", courseRef] }),
        client.invalidateQueries({ queryKey: ["control-room-v2", "catalogue"] }),
      ]);
      setNotice(kind === "unlist" ? "Курс экстренно скрыт." : "Экстренное ограничение снято.");
    });
  };

  if (!state) return <Loading />;
  const document = state.document;
  const restriction = published?.course.editorial_restriction ?? "NONE";
  const publishedLessons = new Set(published?.lessons.map((lesson) => lesson.lesson_ref) ?? []);
  const patchSection = (sectionRef: string, change: (section: EditorialSection) => EditorialSection) =>
    update((value) => ({ ...value, sections: value.sections.map((section) => section.sectionRef === sectionRef ? change(section) : section) }));
  const patchLesson = (lessonRef: string, change: (lesson: EditorialLesson) => EditorialLesson) =>
    update((value) => ({ ...value, lessons: value.lessons.map((lesson) => lesson.lessonRef === lessonRef ? change(lesson) : lesson) }));

  return <div className="editorial-workbench">
    <div className="editorial-status">
      <div><small>ЧЕРНОВИК</small><strong>r{state.revision}{state.dirty ? " · есть изменения" : " · сохранён"}</strong></div>
      <div><small>ПУБЛИКАЦИЯ</small><strong>{state.publishedVersion ? `v${state.publishedVersion}` : "ещё нет"}</strong></div>
      <div><small>ОГРАНИЧЕНИЕ</small><strong>{restriction}</strong></div>
    </div>
    {course.withdrawn ? <Notice>Продукт отозван. Публикация недоступна; сохранённые версии остаются для чтения.</Notice> : null}
    {restriction !== "NONE" ? <Notice>Экстренное ограничение действует независимо от обычной публикации. Для открытия нужен отдельный Relist.</Notice> : null}
    <div className="editorial-fields">
      <label>Название курса<input value={document.title} maxLength={240} onChange={(event) => update((value) => ({ ...value, title: event.target.value }))} /></label>
      <label>Slug курса<input value={document.slug} maxLength={120} disabled={Boolean(published)} onChange={(event) => update((value) => ({ ...value, slug: event.target.value }))} /></label>
      <label className="editorial-wide">Краткое описание<textarea value={document.summary} maxLength={2000} onChange={(event) => update((value) => ({ ...value, summary: event.target.value }))} /></label>
      <label>Видимость после публикации<select value={document.visibility} onChange={(event) => update((value) => ({ ...value, visibility: event.target.value as Visibility }))}>
        <option value="UNLISTED">UNLISTED</option><option value="LISTED">LISTED</option></select></label>
      <label>SEO title<input value={document.seo?.title ?? ""} maxLength={240} onChange={(event) => update((value) => ({ ...value, seo: { ...value.seo, title: event.target.value } }))} /></label>
      <label className="editorial-wide">SEO description<textarea value={document.seo?.description ?? ""} maxLength={1000} onChange={(event) => update((value) => ({ ...value, seo: { ...value.seo, description: event.target.value } }))} /></label>
    </div>
    <LexicalField key={`course-${state.seed}`} label="Текст курса" value={document.description}
      onChange={(description) => update((value) => ({ ...value, description }))} />
    <div className="editorial-tree">
      {document.sections.map((section, sectionIndex) => <section className="editorial-section" key={section.sectionRef}>
        <header><div><small>РАЗДЕЛ {sectionIndex + 1} · {section.sectionRef}</small><h3>{section.title || "Новый раздел"}</h3></div>
          <div className="editorial-order">
            <button type="button" aria-label={`Поднять раздел ${sectionIndex + 1}`} disabled={sectionIndex === 0} onClick={() => update((value) => ({ ...value, sections: move(value.sections, sectionIndex, -1) }))}>↑</button>
            <button type="button" aria-label={`Опустить раздел ${sectionIndex + 1}`} disabled={sectionIndex === document.sections.length - 1} onClick={() => update((value) => ({ ...value, sections: move(value.sections, sectionIndex, 1) }))}>↓</button>
            <button type="button" disabled={document.sections.length === 1} onClick={() => update((value) => {
              const sections = value.sections.filter((item) => item.sectionRef !== section.sectionRef);
              const lessons = value.lessons.filter((item) => item.sectionRef !== section.sectionRef);
              return { ...value, sections, lessons: lessons.length ? lessons : [newLesson(sections[0].sectionRef)] };
            })}>Убрать</button>
          </div></header>
        <div className="editorial-fields">
          <label>Название раздела<input value={section.title} maxLength={240} onChange={(event) => patchSection(section.sectionRef, (item) => ({ ...item, title: event.target.value }))} /></label>
          <label>Видимость<select value={section.visibility} onChange={(event) => patchSection(section.sectionRef, (item) => ({ ...item, visibility: event.target.value as Visibility }))}>
            <option value="LISTED">LISTED</option><option value="UNLISTED">UNLISTED</option></select></label>
        </div>
        {document.lessons.filter((lesson) => lesson.sectionRef === section.sectionRef).map((lesson, lessonIndex, siblings) => <article className="editorial-lesson" key={lesson.lessonRef}>
          <header><small>УРОК {lessonIndex + 1} · {lesson.lessonRef}</small><div className="editorial-order">
            <button type="button" aria-label={`Поднять урок ${lessonIndex + 1}`} disabled={lessonIndex === 0} onClick={() => update((value) => {
              const reordered = move(siblings, lessonIndex, -1);
              return { ...value, lessons: value.lessons.filter((item) => item.sectionRef !== section.sectionRef).concat(reordered) };
            })}>↑</button>
            <button type="button" aria-label={`Опустить урок ${lessonIndex + 1}`} disabled={lessonIndex === siblings.length - 1} onClick={() => update((value) => {
              const reordered = move(siblings, lessonIndex, 1);
              return { ...value, lessons: value.lessons.filter((item) => item.sectionRef !== section.sectionRef).concat(reordered) };
            })}>↓</button>
            <button type="button" disabled={document.lessons.length === 1} onClick={() => update((value) => ({ ...value,
              lessons: value.lessons.filter((item) => item.lessonRef !== lesson.lessonRef) }))}>Убрать</button>
          </div></header>
          <div className="editorial-fields">
            <label>Название урока<input value={lesson.title} maxLength={240} onChange={(event) => patchLesson(lesson.lessonRef, (item) => ({ ...item, title: event.target.value }))} /></label>
            <label>Slug урока<input value={lesson.slug} maxLength={120} disabled={publishedLessons.has(lesson.lessonRef)} onChange={(event) => patchLesson(lesson.lessonRef, (item) => ({ ...item, slug: event.target.value }))} /></label>
            <label>Раздел урока<select value={lesson.sectionRef} disabled={publishedLessons.has(lesson.lessonRef)} onChange={(event) => patchLesson(lesson.lessonRef, (item) => ({ ...item, sectionRef: event.target.value }))}>
              {document.sections.map((item) => <option key={item.sectionRef} value={item.sectionRef}>{item.title || item.sectionRef}</option>)}
            </select></label>
            <label>Видимость<select value={lesson.visibility} onChange={(event) => patchLesson(lesson.lessonRef, (item) => ({ ...item, visibility: event.target.value as Visibility }))}>
              <option value="LISTED">LISTED</option><option value="UNLISTED">UNLISTED</option></select></label>
            <label className="editorial-checkbox"><input type="checkbox" checked={lesson.freePreview} onChange={(event) => patchLesson(lesson.lessonRef, (item) => ({ ...item, freePreview: event.target.checked }))} /> Бесплатный фрагмент</label>
            <label>SEO title урока<input value={lesson.seo?.title ?? ""} maxLength={240} onChange={(event) => patchLesson(lesson.lessonRef, (item) => ({ ...item, seo: { ...item.seo, title: event.target.value } }))} /></label>
            <label className="editorial-wide">SEO description урока<textarea value={lesson.seo?.description ?? ""} maxLength={1000} onChange={(event) => patchLesson(lesson.lessonRef, (item) => ({ ...item, seo: { ...item.seo, description: event.target.value } }))} /></label>
          </div>
          <LexicalField key={`lesson-${lesson.lessonRef}-${state.seed}`} label={`Текст урока ${lessonIndex + 1}`} value={lesson.description}
            onChange={(description) => patchLesson(lesson.lessonRef, (item) => ({ ...item, description }))} />
        </article>)}
        <button type="button" onClick={() => update((value) => ({ ...value, lessons: [...value.lessons, newLesson(section.sectionRef)] }))}>Добавить урок</button>
      </section>)}
      <button type="button" onClick={() => update((value) => ({ ...value, sections: [...value.sections, newSection()] }))}>Добавить раздел</button>
    </div>
    <p className="editorial-hint">Удалённые из редактора опубликованные разделы и уроки сохраняются в Commerce как UNLISTED история.</p>
    {error ? <Notice error={error} /> : null}
    {notice ? <Notice>{notice}</Notice> : null}
    {error && ["DRAFT_REVISION_CONFLICT", "PUBLISHED_VERSION_CONFLICT", "NETWORK_AMBIGUOUS"].includes(error)
      ? <button type="button" onClick={refresh} disabled={busy}>Загрузить серверную версию</button> : null}
    <div className="editorial-actions">
      <button type="button" className="primary" disabled={busy || !state.dirty || course.withdrawn} onClick={save}>Сохранить черновик</button>
      <button type="button" className="primary" disabled={busy || state.dirty || state.revision === 0 || course.withdrawn} onClick={publish}>Опубликовать</button>
      <button type="button" className="danger" disabled={busy || !state.publishedVersion || restriction !== "NONE"} onClick={() => restrict("unlist")}>Экстренно скрыть</button>
    </div>
    {restriction === "EMERGENCY_UNLIST" ? <div className="editorial-relist">
      <label>Причина повторного открытия<input value={relistReason} onChange={(event) => setRelistReason(event.target.value)} /></label>
      <button type="button" disabled={busy || !relistReason.trim()} onClick={() => restrict("relist")}>Relist с аудитом</button>
    </div> : null}
    {published ? <details className="editorial-published"><summary>Опубликованная версия v{published.course.version} · только чтение</summary>
      <p><strong>{published.course.title}</strong> · {published.course.visibility}</p>
      <p>{published.course.summary}</p>
      {published.sections.map((section) => <div key={section.section_ref}>
        <h4>{section.title} · {section.visibility}</h4>
        <ul>{published.lessons.filter((lesson) => lesson.section_ref === section.section_ref).map((lesson) =>
          <li key={lesson.lesson_ref}>{lesson.title} · {lesson.visibility}{lesson.free_preview ? " · preview" : ""}</li>)}</ul>
      </div>)}
    </details> : null}
  </div>;
}

export function EditorialCourseEditor({ courses }: { courses: Course[] }) {
  const [courseRef, setCourseRef] = useState("");
  const selectable = courses.filter((course) => course.projection?.authoringSource !== "LEGACY_MANIFEST");
  const course = selectable.find((item) => item.courseRef === courseRef);
  return <div className="editorial-selector">
    <p>Сначала создайте коммерческий продукт в панели выше. Здесь сохраняется содержание; продажи и цена меняются отдельной командой.</p>
    <label>Курс для редакции<select value={courseRef} onChange={(event) => setCourseRef(event.target.value)}>
      <option value="">Выберите курс</option>{selectable.map((item) => <option key={item.courseRef} value={item.courseRef}>{item.courseRef}</option>)}
    </select></label>
    {course ? <EditorialSession key={course.courseRef} course={course} /> : null}
    {!selectable.length ? <p className="empty">Создайте коммерческий курс с моделью FREE или PAID и закрытым режимом продажи.</p> : null}
  </div>;
}
