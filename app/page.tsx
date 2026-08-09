import HeroSiberia from "@/components/HeroSiberia";
import HeroTour from "@/components/HeroTour";
import HeroVideo from "@/components/HeroVideo";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col font-sans">
      <HeroTour />
      <HeroSiberia />
      <HeroVideo />
    </main>
  );
}
