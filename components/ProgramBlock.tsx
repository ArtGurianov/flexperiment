import Image, { type StaticImageData } from "next/image";

import DarkPanel from "@/components/DarkPanel";

type ProgramBlockProps = {
  /* Doubles as the title image's alt text — the artwork is the heading, so it
     needs a real accessible name rather than being marked decorative. */
  title: string;
  titleImage: StaticImageData;
  item: StaticImageData;
  /* Placement of the decorative item — passed in because Theory's piece is
     landscape and Practice's is portrait, so they need different anchoring. */
  itemClassName: string;
  itemSizes: string;
  steps: string[];
  className?: string;
};

// Theory and Practice are the same composition with different content, so the
// layering lives here once: item behind, panel over it, title on top.
export default function ProgramBlock({
  title,
  titleImage,
  item,
  itemClassName,
  itemSizes,
  steps,
  className = "",
}: ProgramBlockProps) {
  return (
    <div className={`relative ${className}`}>
      {/* Fixed height with automatic width: the two title files have different
          aspect ratios, so matching on height is what keeps their lettering the
          same size as each other. */}
      <h3 className="relative z-20">
        <Image src={titleImage} alt={title} sizes="200px" className="h-12 w-auto" />
      </h3>

      {/* Deliberately behind the panel: DarkPanel is 50% translucent, so the
          object reads through the copy instead of being hidden by it. */}
      <Image
        src={item}
        alt=""
        aria-hidden="true"
        sizes={itemSizes}
        className={`pointer-events-none absolute z-0 h-auto select-none ${itemClassName}`}
      />

      <DarkPanel className="relative z-10 mt-[6cqw] px-[6cqw] py-[7cqw]">
        <ol className="list-decimal space-y-[3.5cqw] pl-[1.3em] text-[clamp(0.95rem,3.9cqw,1.25rem)] leading-[1.8] marker:text-acid">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </DarkPanel>
    </div>
  );
}
