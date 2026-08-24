export function EvidenceCard({ title, data }: { title: string; data: unknown }) {
  return (
    <article className="evidence">
      <h3>{title}</h3>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </article>
  );
}
