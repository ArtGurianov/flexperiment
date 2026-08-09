import HeroSiberia from "@/components/HeroSiberia";
import HeroTour from "@/components/HeroTour";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col font-sans">
      <HeroTour />
      <HeroSiberia />
    </main>
  );
}
