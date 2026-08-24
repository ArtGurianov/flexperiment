import { badgeTone } from "../../lib/badge-tone";

export function Badge({ children }: { children?: React.ReactNode }) {
  const text = String(children ?? "").trim() || "—";
  return <span className={`badge badge-${badgeTone(text)}`}>{text}</span>;
}
