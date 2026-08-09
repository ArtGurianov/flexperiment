import type { Metadata } from "next";
import SlimeHorror from "@/components/SlimeHorror";

export const metadata: Metadata = {
  title: "Glossy Slime Text",
};

export default function SlimeTextPage() {
  return <SlimeHorror value="FLEXTATIC" className="h-dvh w-full bg-black" />;
}
