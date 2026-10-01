import { getPayload } from "payload";
import config from "@payload-config";
import { getPublishedCourseSlug } from "./editorial";

export async function publishedCourseSlug(courseRef: string): Promise<string | null> {
  return getPublishedCourseSlug(await getPayload({ config }), courseRef);
}
