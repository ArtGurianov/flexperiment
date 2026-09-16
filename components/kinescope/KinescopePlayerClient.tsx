"use client";

import KinescopePlayerInstance, {
  type PlayerPropsTypes,
} from "@kinescope/react-kinescope-player";
import type { ComponentType, RefAttributes, RefObject } from "react";

type Props = PlayerPropsTypes & {
  forwardRef?: RefObject<KinescopePlayerInstance | null>;
};

// next/dynamic intentionally erases the class component's ref type. Restore it
// in this client-only leaf rather than exposing the library at every call site.
const PlayerWithRef = KinescopePlayerInstance as unknown as ComponentType<
  PlayerPropsTypes & RefAttributes<KinescopePlayerInstance>
>;

export default function KinescopePlayerClient({ forwardRef, ...props }: Props) {
  return <PlayerWithRef {...props} ref={forwardRef} />;
}
