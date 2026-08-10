import Diamond from "@/components/Diamond";
import { cn } from "@/lib/cn";

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
    detail: "CJ Rey, BSV Poba, Ghost, Chinx, Lil Buck, Klassic, Tafari и другие",
  },
];

// Titles have to hold one line inside a half-width column. Measured in
// Shafarik, the widest of them ("КОЛЛАБЫ С ТОПАМИ") runs 8.792x its font size,
// and the marker plus gutter cost another 1.4em, so the column fits only while
// `8.792F + 1.4F <= 50cqw` — that is, F <= 4.9cqw. Kept as a bare ratio rather
// than a clamp: any fixed px bound would break the relationship at some width
// and wrap the titles. Detail copy is decoupled so it stays readable.
export default function TeacherCredentials({ className }: { className?: string }) {
  return (
    <ul className={cn("space-y-[4.5cqw]", className)}>
      {CREDENTIALS.map(({ title, detail }) => (
        <li
          key={title}
          className="grid grid-cols-[0.7em_1fr] gap-x-[0.7em] text-[4.8cqw]"
        >
          <Diamond
            className="size-[0.42em] bg-acid"
            wrapperClassName="mt-[0.5em] drop-shadow-[2px_3px_0_var(--color-shadow)]"
          />

          <div>
            <h3 className="leading-[1.05] whitespace-nowrap uppercase text-acid [text-shadow:2px_3px_0_var(--color-shadow)]">
              {title}
            </h3>

            {/* Clamped rather than a bare cqw like the title above: the title
                is ratio-locked to keep it on one line, but the detail copy has
                no such constraint, and at 3.4cqw it fell under 10px in a
                half-width column on a 320px phone. */}
            {detail && (
              <p className="mt-[0.6em] text-[clamp(0.75rem,3.4cqw,1.05rem)] leading-[1.55] text-acid/85 [text-shadow:2px_2px_0_var(--color-shadow)]">
                ({detail})
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
