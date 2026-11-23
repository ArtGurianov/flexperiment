import { cabinetOrigins } from "@/components/cabinet/data";
import { requestCabinet, requireSignedIn } from "@/components/cabinet/request";
import { CoursesView } from "@/components/cabinet/views";

/** FLEX-123 «Мои курсы»: free enrolments and purchase rights; "Начат" is a separate fact. Full progress — FLEX-129. */
export default async function CoursesPage() {
  const cabinet = await requestCabinet();
  const courses = requireSignedIn(await cabinet.courses(), "/courses");
  return <><h1>Мои курсы</h1><CoursesView result={courses} platformOrigin={cabinetOrigins().platform} heading="Доступные курсы" /></>;
}
