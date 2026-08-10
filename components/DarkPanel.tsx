import type { ComponentPropsWithoutRef } from "react";

// A translucent slab that carries its own contrast, so sections can sit on the
// site background unaltered instead of baking a darkened patch into artwork.
// The glow stays directional — offset left and down, the way it falls in the
// poster — but is soft rather than a hard offset edge.
export default function DarkPanel({
  className = "",
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={`bg-[rgb(22_20_18_/_0.5)] shadow-[-10px_10px_24px_rgb(202_255_86_/_0.3),-16px_16px_48px_rgb(202_255_86_/_0.18)] ${className}`}
      {...props}
    />
  );
}
