import { requestCabinet, requireSignedIn } from "@/components/cabinet/request";
import { ProfileView } from "@/components/cabinet/views";

/** FLEX-123 profile on my: the closed #286 §10 MY view (full e-mail only here, never on LMS/LAB). */
export default async function ProfilePage() {
  const cabinet = await requestCabinet();
  const profile = requireSignedIn(await cabinet.profile(), "/profile");
  return <><h1>Профиль</h1><ProfileView result={profile} /></>;
}
