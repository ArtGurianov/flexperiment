const CREDENTIALS: { title: string; detail?: string }[] = [
  { title: "12 лет флексинга" },
  { title: "Танцы на ТНТ" },
  {
    title: "Видео кампейны",
    detail:
      "S7 Airlines, Uniqlo, Black Star Wear, Interview Magazine, Mastermind Japan и другие",
  },
  {
    title: "Коллабы с топами",
    detail: "CJ Rey, BSV Рова, Ghost, Chinx, Lil Buck, Klassic, Tafari и другие",
  },
];

// Titles have to hold one line inside a half-width column. Measured in
// Shafarik, the widest of them ("КОЛЛАБЫ С ТОПАМИ") runs 8.792x its font size,
// and the marker plus gutter cost another 1.4em, so the column fits only while
// `8.792F + 1.4F <= 50cqw` — that is, F <= 4.9cqw. Kept as a bare ratio rather
// than a clamp: any fixed px bound would break the relationship at some width
// and wrap the titles. Detail copy is decoupled so it stays readable.
export default function TeacherCredentials({ className = "" }: { className?: string }) {
  return (
    <ul className={`space-y-[4.5cqw] ${className}`}>
      {CREDENTIALS.map(({ title, detail }) => (
        <li
          key={title}
          className="grid grid-cols-[0.7em_1fr] gap-x-[0.7em] text-[4.8cqw]"
        >
          {/* Two elements on purpose. The shadow has to match the title's
              `text-shadow: 2px 3px`, which is a screen-space offset — but a
              box-shadow (or a filter on the rotated node itself) resolves in
              the element's own coordinates and would come out thrown 45° off
              with it. Rotating the inner square and filtering the unrotated
              wrapper keeps the offset pointing the same way as the text's. */}
          <span
            aria-hidden="true"
            className="mt-[0.5em] block drop-shadow-[2px_3px_0_#090909]"
          >
            <span className="block size-[0.42em] shrink-0 rotate-45 bg-acid" />
          </span>

          <div>
            <h3 className="leading-[1.05] whitespace-nowrap uppercase text-acid [text-shadow:2px_3px_0_#090909]">
              {title}
            </h3>

            {detail && (
              <p className="mt-[0.6em] text-[3.4cqw] leading-[1.55] text-acid/85 [text-shadow:2px_2px_0_#101010]">
                ({detail})
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
