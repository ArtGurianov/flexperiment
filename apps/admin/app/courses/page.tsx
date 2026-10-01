import { Suspense } from "react";
import { AdminApp } from "../../components/AdminApp";

export default function CoursesPage() {
  return <Suspense fallback={null}><AdminApp page="courses" /></Suspense>;
}
