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
      {/* Fixed height with automatic width. Both files are cropped flush to
          their lettering - which is what makes matching on height meaningful -
          but at different aspect ratios (2.86:1 Теория, 3.69:1 Практика), so
          height is the only axis that keeps the two the same size as each
          other. At h-12 that renders them 137px and 177px wide; the 180px hint
          covers the wider of the two without pushing the srcset pick up to the
          next candidate. */}
      <h3 className="relative z-20">
        <Image src={titleImage} alt={title} sizes="180px" className="h-12 w-auto" />
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
