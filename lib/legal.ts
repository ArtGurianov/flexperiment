/**
 * The legal documents, in the order they appear in the footer.
 *
 * `label` is the short name used for links and <title>; the documents' own
 * headings are longer ("Публичная оферта на оказание услуг по проведению
 * танцевальных мастер-классов") and would not fit a footer column.
 *
 * Deliberately free of any Node import so a client component can pull the list
 * in without dragging `node:fs` into the browser bundle — the pages read the
 * matching `public/legal/<slug>.md` themselves.
 */
export const LEGAL_DOCUMENTS = [
  {
    slug: "privacy-policy",
    label: "Политика конфиденциальности",
    description:
      "Порядок обработки и защиты персональных данных пользователей сайта flexperiment.ru.",
  },
  {
    slug: "personal-data-consent",
    label: "Согласие на обработку персональных данных",
    description:
      "Условия согласия на обработку персональных данных, предоставляемого при отправке формы на сайте flexperiment.ru.",
  },
  {
    slug: "public-offer",
    label: "Договор-оферта",
    description:
      "Публичная оферта на оказание услуг по проведению танцевальных мастер-классов FLEXPERIMENT.",
  },
  {
    slug: "disclaimer",
    label: "Отказ от ответственности",
    description:
      "Особенности участия в танцевальных мастер-классах FLEXPERIMENT и использования сайта flexperiment.ru.",
  },
] as const;

export type LegalDocument = (typeof LEGAL_DOCUMENTS)[number];

export function findLegalDocument(slug: string): LegalDocument | undefined {
  return LEGAL_DOCUMENTS.find((document) => document.slug === slug);
}
