import SlimeHorror from "@/components/SlimeHorror";

export default function HeroSiberia() {
  return (
    <section className="flex flex-col w-full items-center justify-center">
      <SlimeHorror value="СИБИРЬ" className="w-full -rotate-12" color="#CAFF56" />
      <SlimeHorror value="2026" className="w-1/2 self-end" color="#CAFF56" />
    </section>
  );
}
