export type Visibility = "LISTED" | "UNLISTED";

export type Restriction =
  | { readonly kind: "EFFECTIVE_VISIBILITY"; readonly value: "UNLISTED" }
  | { readonly kind: "FREE_PREVIEW"; readonly value: "FALSE" };

export type RestrictiveOperation = {
  readonly operationId: string;
  readonly courseRef: string;
  readonly scope: { readonly level: "COURSE" | "SECTION" | "LESSON"; readonly ref: string };
  readonly expected: Restriction;
  readonly deadlineAt: string;
  readonly platformEpoch: string;
};

export type CourseManifest = {
  readonly courseRef: string;
  readonly version: number;
  readonly contentHash: string;
  readonly visibility: Visibility;
  readonly sections: ReadonlyArray<{
    readonly sectionRef: string;
    readonly visibility: Visibility;
    readonly position: number;
  }>;
  readonly lessons: ReadonlyArray<{
    readonly lessonRef: string;
    readonly sectionRef: string;
    readonly everPublished: boolean;
    readonly visibility: Visibility;
    readonly freePreview: boolean;
    readonly position: number;
  }>;
  readonly operations: ReadonlyArray<{ readonly operationId: string; readonly committedVersion: number }>;
};

/**
 * Every operation the pushed manifest carried, by its commerce state, whether resolved by this push
 * or an earlier one, so re-pushing the same committed manifest recovers a lost acknowledgement.
 */
export type ManifestAck = {
  readonly kind: "APPLIED" | "NO_OP";
  readonly finalized: readonly string[];
  readonly superseded: readonly string[];
  readonly lateCommitted: readonly string[];
  readonly stillOpen: readonly string[];
};
