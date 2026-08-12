import { Fragment, type ReactNode } from "react";

/**
 * A small Markdown reader for the four legal documents in `public/legal`.
 *
 * Deliberately not a dependency: those files are authored in this repo and use
 * one narrow slice of the syntax — headings, paragraphs with hard breaks,
 * bullet and numbered lists, one blockquote, bold, and links. `react-markdown`
 * plus `remark` would add ~40KB of parser to a site whose whole point is
 * loading fast, to render four static pages at build time.
 *
 * Output is React elements rather than an HTML string, so nothing here is ever
 * fed to `dangerouslySetInnerHTML` and the documents' content cannot inject
 * markup. No classes are attached either — styling lives with the page that
 * renders the result, which keeps this module free of design decisions.
 *
 * Anything outside that slice (tables, nested lists, code, images, emphasis)
 * falls through as literal text rather than being silently dropped, so an
 * unsupported construct shows up in review instead of disappearing.
 */

/** Bold and links. Non-greedy so two runs on one line stay separate. */
const INLINE_PATTERN = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

const HEADING = /^(#{1,6})\s+(.+)$/;
const BULLET = /^[-*]\s+(.+)$/;
/**
 * The trailing `\s` is load-bearing. `public-offer.md` numbers its clauses
 * "2.1. Настоящая Оферта…" — without the whitespace requirement the "2."
 * reads as a list marker and every clause becomes its own single-item <ol>.
 */
const ORDERED = /^\d+\.\s+(.+)$/;
const QUOTE = /^>\s?(.*)$/;
/** Markdown's hard line break: two or more spaces at end of line. */
const HARD_BREAK = /\s{2,}$/;

function startsBlock(line: string) {
  return (
    !line.trim() ||
    HEADING.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    QUOTE.test(line)
  );
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  // The pattern is module-level and global, so its lastIndex survives between
  // calls; resetting it here is what keeps each line independent.
  INLINE_PATTERN.lastIndex = 0;

  for (
    let match = INLINE_PATTERN.exec(text);
    match !== null;
    match = INLINE_PATTERN.exec(text)
  ) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));

    const key = `${keyPrefix}-${match.index}`;

    if (match[1] !== undefined) {
      nodes.push(<strong key={key}>{match[1]}</strong>);
    } else {
      const href = match[3];
      const isExternal = /^[a-z]+:/i.test(href);
      nodes.push(
        <a
          key={key}
          href={href}
          {...(isExternal
            ? { target: "_blank", rel: "noopener noreferrer" }
            : {})}
        >
          {match[2]}
        </a>,
      );
    }

    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/**
 * One paragraph, joining its lines the way Markdown does: a soft wrap collapses
 * to a space, two trailing spaces become a <br />. The contact blocks at the
 * foot of every document rely on the second case.
 */
function renderParagraph(lines: string[], keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];

  lines.forEach((line, index) => {
    if (index > 0) {
      nodes.push(
        HARD_BREAK.test(lines[index - 1]) ? (
          <br key={`${keyPrefix}-br-${index}`} />
        ) : (
          " "
        ),
      );
    }

    nodes.push(
      <Fragment key={`${keyPrefix}-line-${index}`}>
        {renderInline(line.trim(), `${keyPrefix}-${index}`)}
      </Fragment>,
    );
  });

  return nodes;
}

/**
 * Consumes the run of consecutive lines matching `pattern` starting at `from`,
 * returning each line's first capture group alongside the index to resume at.
 */
function collect(lines: string[], from: number, pattern: RegExp) {
  const items: string[] = [];
  let index = from;

  while (index < lines.length) {
    const match = pattern.exec(lines[index]);
    if (!match) break;
    items.push(match[1]);
    index++;
  }

  return { items, index };
}

export function renderMarkdown(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index++;
      continue;
    }

    // The line a block opens on is unique to it, which makes it a stable key.
    const start = index;

    const heading = HEADING.exec(line);
    if (heading) {
      const Tag = `h${heading[1].length}` as "h1";
      blocks.push(
        <Tag key={start}>{renderInline(heading[2].trim(), `h${start}`)}</Tag>,
      );
      index++;
      continue;
    }

    if (BULLET.test(line)) {
      const list = collect(lines, index, BULLET);
      index = list.index;
      blocks.push(
        <ul key={start}>
          {list.items.map((item, offset) => (
            <li key={offset}>{renderInline(item, `ul${start}-${offset}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (ORDERED.test(line)) {
      const list = collect(lines, index, ORDERED);
      index = list.index;
      blocks.push(
        <ol key={start}>
          {list.items.map((item, offset) => (
            <li key={offset}>{renderInline(item, `ol${start}-${offset}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    if (QUOTE.test(line)) {
      const quote = collect(lines, index, QUOTE);
      index = quote.index;
      blocks.push(
        <blockquote key={start}>
          <p>{renderParagraph(quote.items, `bq${start}`)}</p>
        </blockquote>,
      );
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && !startsBlock(lines[index])) {
      paragraph.push(lines[index]);
      index++;
    }
    blocks.push(<p key={start}>{renderParagraph(paragraph, `p${start}`)}</p>);
  }

  return blocks;
}
