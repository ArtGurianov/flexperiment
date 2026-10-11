import type { PayloadRequest } from "payload";

/** Editorial proposal, not a published catalogue or video metadata. No external IDs are invented. */
export const flexing101Proposal = {
  status: "DRAFT_OWNER_REVIEW",
  title: "Flexing 101",
  slug: "flexing-101",
  author: "Арт",
  summary: "Бесплатный вводный онлайн-курс по флексингу. Предварительный учебный план; материалы ещё готовятся.",
  accessModel: "FREE",
  priceMinor: 0,
  accessRequirement: "VERIFIED_EMAIL",
  proposedAccessTerm: "Бессрочно, пока курс доступен на платформе",
  grading: false,
  certificate: false,
  sectionTitle: "Введение в флексинг",
  lessons: [
    { slug: "introduction", title: "Что такое флексинг", proposedMinutes: 3 },
    { slug: "body-isolation", title: "Контроль тела и базовая изоляция", proposedMinutes: 5 },
    { slug: "movement-connections", title: "Первые движения и соединение элементов", proposedMinutes: 7 },
    { slug: "practice-combination", title: "Короткая практическая комбинация", proposedMinutes: 5 },
  ],
} as const;

/**
 * Local API preparation ONLY: uses real collections, auth/access and immutable-ref hooks.
 * No endpoint, auto-run or deployment hook invokes this. The closed live canary keeps refusing
 * writes through its existing collection hooks. Call with a real authenticated editorial req
 * against an isolated preparation DB, never production. All records remain draft + unlisted.
 */
export async function prepareFlexing101Draft(req: PayloadRequest) {
  if (!req.user || req.user.collection !== "users") throw new Error("EDITORIAL_AUTHOR_REQUIRED");
  if (process.env.DEPLOY_ENV === "production" || process.env.NODE_ENV === "production") {
    throw new Error("DRAFT_PREPARATION_PRODUCTION_FORBIDDEN");
  }
  if (req.transactionID) throw new Error("DRAFT_PREPARATION_REQUIRES_OWN_TRANSACTION");
  const { payload } = req;
  const transactionID = await payload.db.beginTransaction();
  if (transactionID == null) throw new Error("DRAFT_PREPARATION_TRANSACTION_REQUIRED");
  req.transactionID = transactionID;
  try {
    const existing = await payload.count({
      collection: "courses", where: { slug: { equals: flexing101Proposal.slug } },
      overrideAccess: false, req,
    });
    if (existing.totalDocs !== 0) throw new Error("FLEXING101_ALREADY_EXISTS");
    const course = await payload.create({
      collection: "courses", draft: true, depth: 0, overrideAccess: false, req,
      data: {
        title: flexing101Proposal.title, slug: flexing101Proposal.slug,
        summary: flexing101Proposal.summary, visibility: "unlisted", _status: "draft",
      },
    });
    const section = await payload.create({
      collection: "sections", draft: true, depth: 0, overrideAccess: false, req,
      data: {
        course: course.id, title: flexing101Proposal.sectionTitle, position: 0,
        visibility: "unlisted", _status: "draft",
      },
    });
    const lessons = [];
    for (const [position, lesson] of flexing101Proposal.lessons.entries()) {
      lessons.push(await payload.create({
        collection: "lessons", draft: true, depth: 0, overrideAccess: false, req,
        data: {
          course: course.id, section: section.id, title: lesson.title, slug: lesson.slug,
          position, freePreview: false, visibility: "unlisted", _status: "draft",
          // proposedMinutes is deliberately NOT written to durationSeconds.
          // No videoRef or upload: those must come from actual Kinescope processing.
        },
      }));
    }
    await payload.db.commitTransaction(transactionID);
    return { course, section, lessons };
  } catch (error) {
    await payload.db.rollbackTransaction(transactionID);
    throw error;
  } finally {
    delete req.transactionID;
  }
}
