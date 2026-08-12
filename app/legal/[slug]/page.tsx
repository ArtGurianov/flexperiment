import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import Footer from "@/components/Footer";
import Section from "@/components/Section";
import { LEGAL_DOCUMENTS, findLegalDocument } from "@/lib/legal";
import { renderMarkdown } from "@/lib/markdown";

// The four documents are the only ones that exist, so anything else is a 404
// rather than a build-time miss followed by a runtime read of an arbitrary
// path. It also means no `fs` call ever happens outside `next build`.
export const dynamicParams = false;

export function generateStaticParams() {
  return LEGAL_DOCUMENTS.map(({ slug }) => ({ slug }));
}

export async function generateMetadata(
  props: PageProps<"/legal/[slug]">,
): Promise<Metadata> {
  const { slug } = await props.params;
  const document = findLegalDocument(slug);

  if (!document) return {};

  return {
    title: `${document.label} — FLEXTATIC`,
    description: document.description,
    alternates: { canonical: `/legal/${document.slug}` },
    openGraph: {
      type: "article",
      locale: "ru_RU",
      url: `/legal/${document.slug}`,
      siteName: "FLEXTATIC",
      title: `${document.label} — FLEXTATIC`,
      description: document.description,
    },
  };
}

/**
 * The prose styling for the rendered Markdown.
 *
 * Attached here rather than inside the renderer so `lib/markdown` stays a
 * parser with no opinion about how the site looks. Body copy drops to the
 * system sans: Shafarik is a display face with one 400 weight, and 250 lines of
 * contract set in it is close to unreadable — headings keep it, so the pages
 * still read as part of the site.
 */
const PROSE = [
  "font-sans text-[clamp(0.85rem,3.3cqw,1rem)] leading-relaxed text-bone/85",
  "[&_h1]:mt-0 [&_h1]:mb-[6cqw] [&_h1]:font-display [&_h1]:text-[clamp(1.3rem,5.6cqw,1.9rem)] [&_h1]:leading-tight [&_h1]:text-acid [&_h1]:uppercase [&_h1]:[text-shadow:2px_3px_0_var(--color-shadow)]",
  "[&_h2]:mt-[9cqw] [&_h2]:mb-[3cqw] [&_h2]:font-display [&_h2]:text-[clamp(1.05rem,4.2cqw,1.35rem)] [&_h2]:leading-tight [&_h2]:text-bone [&_h2]:uppercase",
  "[&_h3]:mt-[6cqw] [&_h3]:mb-[2cqw] [&_h3]:font-display [&_h3]:text-[clamp(0.95rem,3.6cqw,1.15rem)] [&_h3]:text-bone [&_h3]:uppercase",
  "[&_p]:my-[3.5cqw]",
  "[&_ul]:my-[3.5cqw] [&_ul]:list-disc [&_ol]:my-[3.5cqw] [&_ol]:list-decimal",
  "[&_ol]:pl-[1.5em] [&_ul]:pl-[1.5em]",
  "[&_li]:my-[1.5cqw] [&_li]:marker:text-acid",
  "[&_blockquote]:my-[4cqw] [&_blockquote]:border-l-2 [&_blockquote]:border-acid [&_blockquote]:py-[1cqw] [&_blockquote]:pl-[1em] [&_blockquote]:text-bone",
  "[&_strong]:font-semibold [&_strong]:text-bone",
  "[&_a]:text-acid [&_a]:underline [&_a]:underline-offset-4 [&_a]:break-words",
].join(" ");

export default async function LegalPage(props: PageProps<"/legal/[slug]">) {
  const { slug } = await props.params;
  const document = findLegalDocument(slug);

  // Unreachable while `dynamicParams` is false, but it is what narrows `slug`
  // from `string` to a known document for the read below.
  if (!document) notFound();

  const source = await readFile(
    path.join(process.cwd(), "public", "legal", `${document.slug}.md`),
    "utf8",
  );

  return (
    <>
      {/* tabIndex -1 for the same reason as the home page's: the back link
          below is the first tab stop, so there is no navigation to skip past
          and no skip link — but the landmark still has to be focusable for
          anything that jumps to it. */}
      <main
        id="main"
        tabIndex={-1}
        className="flex flex-1 flex-col overflow-x-clip outline-none"
      >
        <Section className="pb-[10cqw]">
          <Link
            href="/"
            className="mb-[7cqw] inline-block text-[clamp(0.8rem,3cqw,1rem)] text-acid uppercase underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acid"
          >
            ← На главную
          </Link>

          <article className={PROSE}>{renderMarkdown(source)}</article>
        </Section>
      </main>

      <Footer />
    </>
  );
}
