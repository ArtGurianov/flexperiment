import HeroSiberia from "@/components/HeroSiberia";
import HeroTour from "@/components/HeroTour";
import HeroVideo from "@/components/HeroVideo";
import ProgramSection from "@/components/ProgramSection";
import Separator from "@/components/Separator";
import TeacherSection from "@/components/TeacherSection";
import WorkshopIntro from "@/components/WorkshopIntro";

export default function Home() {
  return (
    // overflow-x-clip rather than -hidden: clip does not turn the element into
    // a scroll container and leaves the vertical axis alone, so position:sticky
    // keeps working inside sections.
    <main className="flex flex-1 flex-col overflow-x-clip font-sans">
      <HeroTour />
      <HeroSiberia />
      <Separator />
      <HeroVideo />
      <WorkshopIntro />
      <Separator />
      <TeacherSection />
      <Separator />
      <ProgramSection />
    </main>
  );
}
