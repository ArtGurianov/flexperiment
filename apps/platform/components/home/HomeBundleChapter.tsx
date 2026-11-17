import Link from "next/link";
import HomeChapter from "./HomeChapter";

export default function HomeBundleChapter() {
  return (
    <HomeChapter path="/all-courses" title="Все курсы комплектом" bundle>
      <h1 className="m-0 max-w-[15ch] font-display text-[clamp(2rem,8vw,7rem)] font-bold leading-[.95] tracking-[-.06em]">
        Хотите все курсы одним комплектом?
      </h1>
      <p className="m-0 text-lg">Продажи комплекта пока закрыты.</p>
      <Link href="/courses" className="inline-flex w-fit items-center gap-4 bg-ink px-5 py-3 font-bold text-paper! hover:bg-paper hover:text-ink! focus-visible:bg-paper focus-visible:text-ink!">
        Посмотреть каталог <span aria-hidden>↗</span>
      </Link>
    </HomeChapter>
  );
}
