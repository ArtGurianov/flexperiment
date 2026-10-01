import { notFound } from "next/navigation";
import LegalDocumentRedirect from "@/components/legal/LegalDocumentRedirect";

const documents = {
  privacy: { kind: "privacy", title: "Политика конфиденциальности" },
  "personal-data": { kind: "personal_data", title: "Согласие на обработку персональных данных" },
  "account-terms": { kind: "account_terms", title: "Условия аккаунта" },
  marketing: { kind: "marketing_consent", title: "Условия информационной рассылки" },
} as const;

export function generateStaticParams() { return Object.keys(documents).map((kind) => ({ kind })); }

export default async function LegalDocumentPage({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  const document = documents[kind as keyof typeof documents];
  if (!document) notFound();
  return <LegalDocumentRedirect kind={document.kind} title={document.title} />;
}
