import Link from "next/link";
import type { Metadata } from "next";
import CourseOrbit from "@/components/home/CourseOrbit";
import { dummyCourses } from "@/components/home/dummy-courses";

export const metadata: Metadata = { alternates: { canonical: "/" } };

const principles = [
  ["Техника", "Разбираем механику движения до ясного телесного ощущения."],
  ["Музыка", "Учимся слышать акценты и принимать решения внутри трека."],
  ["Язык", "Собираем свой словарь, а не копируем готовую связку."],
] as const;

export default function HomePage() {
  return (
    <main>
      <CourseOrbit courses={dummyCourses}>
        <nav className="nav" aria-label="Основная навигация">
          <Link className="wordmark" href="/">FLEXPERIMENT<span>®</span></Link>
          <div className="navLinks"><Link href="/courses">Курсы</Link><Link href="/account">Мои курсы</Link></div>
        </nav>
      </CourseOrbit>
      <section className="manifesto" aria-labelledby="method-title">
        <p className="sectionNumber">01 / метод</p>
        <h2 id="method-title">Не коллекция уроков.<br />Система внимания.</h2>
        <div className="principles">
          {principles.map(([title, text], index) => (
            <article key={title}><span>0{index + 1}</span><h3>{title}</h3><p>{text}</p></article>
          ))}
        </div>
      </section>
      <footer><p>Flexperiment · движение как исследование</p><Link href="/legal/privacy">Конфиденциальность</Link></footer>
    </main>
  );
}
