"use client";

import dynamic from "next/dynamic";
import type { RefObject } from "react";

import type KinescopePlayerInstance from "@kinescope/react-kinescope-player";
import type { PlayerPropsTypes } from "@kinescope/react-kinescope-player";

// The package creates an iframe and touches browser APIs as it loads, so it
// must not be rendered by Next's static/server pass. Individual video surfaces
// therefore only express their UX policy.
const KinescopePlayerClient = dynamic(
  () => import("./KinescopePlayerClient"),
  { ssr: false },
);

export type KinescopePlayerHandle = KinescopePlayerInstance;

type Props = PlayerPropsTypes & {
  forwardRef?: RefObject<KinescopePlayerInstance | null>;
};

export default function KinescopePlayer({ forwardRef, ...props }: Props) {
  return <KinescopePlayerClient {...props} forwardRef={forwardRef} />;
}
