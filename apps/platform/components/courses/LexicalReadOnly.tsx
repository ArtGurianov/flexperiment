import type { ReactNode } from "react";

type Node = { type?: unknown; text?: unknown; format?: unknown; children?: unknown };

function renderLeaf(value: unknown, key: number): ReactNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const node = value as Node;
  if (node.type === "linebreak") return <br key={key} />;
  if (node.type !== "text" || typeof node.text !== "string") return null;
  const format = typeof node.format === "number" ? node.format : 0;
  let content: ReactNode = node.text;
  if (format & 1) content = <strong>{content}</strong>;
  if (format & 2) content = <em>{content}</em>;
  return <span key={key}>{content}</span>;
}

/** The Commerce editor admits only root → paragraph → text/linebreak nodes. */
export default function LexicalReadOnly({ data }: { data: unknown }) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const root = (data as { root?: Node }).root;
  if (root?.type !== "root" || !Array.isArray(root.children)) return null;
  return <>{root.children.map((value: unknown, key: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const paragraph = value as Node;
    if (paragraph.type !== "paragraph" || !Array.isArray(paragraph.children)) return null;
    return <p key={key}>{paragraph.children.map(renderLeaf)}</p>;
  })}</>;
}
