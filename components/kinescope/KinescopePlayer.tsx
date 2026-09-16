"use client";

import dynamic from "next/dynamic";

import type { KinescopePlayerProps } from "./KinescopePlayerClient";

// The player creates an iframe and touches browser APIs, so it must not be
// rendered by Next's static/server pass. Individual video surfaces therefore
// only express their UX policy.
const KinescopePlayerClient = dynamic(() => import("./KinescopePlayerClient"), {
  ssr: false,
});

export type { KinescopePlayerProps };

export default function KinescopePlayer(props: KinescopePlayerProps) {
  return <KinescopePlayerClient {...props} />;
}
