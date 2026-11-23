import type { Metadata } from "next";
import LabInterestLink from "../../components/LabInterestLink";
export const metadata: Metadata = { title: "Предзапись LAB", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default function InterestPage() { return <LabInterestLink />; }
