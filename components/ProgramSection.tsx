import ProgramBlock from "@/components/ProgramBlock";
import practiceItem from "@/public/practice-item.webp";
import practiceTitle from "@/public/practice-title.webp";
import theoryItem from "@/public/theory-item.webp";
import theoryTitle from "@/public/theory-title.webp";

const THEORY = [
  "Обзор и выбор направлений во флексинге по своим физическим возможностям - собери свой уникальный запоминающийся образ.",
  "Вход в состояние потока и креативность через танец. Как придумывать и комбинировать движения.",
  "Разберем иллюзии и абстракции. Как танцевать, чтобы было интересно под любую музыку.",
];

const PRACTICE = [
  "Упражнения на координацию и управление телом. Упражнения по растяжке и мобильности.",
  "Попробуем техники каждого направления флексинга (анимации, таттинг, глайдинг и др.).",
  "Выучим связку с комбинацией этих направлений для понимания сочетаний и переходов между ними.",
];

// overflow-hidden belongs to the section rather than the individual blocks, so
// the objects can bleed past the column edge and still overlap freely between
// a block's title and its panel.
export default function ProgramSection() {
  return (
    <section
      id="program"
      className="@container relative w-full scroll-mt-14 overflow-hidden px-4 py-10 font-display text-bone"
    >
      <h2 className="text-right text-[clamp(1.15rem,5cqw,1.6rem)] leading-none uppercase text-acid">
        Программа мастер-класса
      </h2>

      <ProgramBlock
        className="mt-[7cqw]"
        title="Теория"
        titleImage={theoryTitle}
        item={theoryItem}
        itemClassName="-top-[3cqw] -right-[11cqw] w-[58cqw]"
        itemSizes="(min-width: 512px) 278px, 58vw"
        steps={THEORY}
      />

      <ProgramBlock
        className="mt-[11cqw]"
        title="Практика"
        titleImage={practiceTitle}
        item={practiceItem}
        itemClassName="-top-[7cqw] -right-[13cqw] w-[50cqw]"
        itemSizes="(min-width: 512px) 240px, 50vw"
        steps={PRACTICE}
      />
    </section>
  );
}
