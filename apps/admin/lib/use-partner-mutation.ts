import { useMutation, useQueryClient, type UseMutationOptions } from "@tanstack/react-query";
import { type PartnerApiError } from "./partner-api";
import { shouldRefreshAuthoritativeState } from "./idempotency";
import { partnerInvalidationKeysFor, type PartnerMutation, type PartnerMutationContext } from "./partner-invalidation";

/**
 * PR-C: the only sanctioned way to mutate partner state, the exact
 * counterpart of useAdminMutation. No partner component may call
 * queryClient.invalidateQueries directly - that is how the divergent,
 * forgettable per-component wiring this PR removes grows back.
 *
 * Two properties matter more here than the tidiness. First, every
 * invalidation is awaited inside onSuccess, which is also what keeps
 * isPending true until the refetch completes, so a submit button cannot go
 * idle while the screen still shows pre-command state. Second - and this is
 * the reliability contract the raw `partnerApi` + local `busy/error` pattern
 * never had - an ambiguous failure refreshes authoritative state instead of
 * leaving the partner staring at an error for a command that may well have
 * committed.
 *
 * Note what this deliberately does NOT do: mint or retain an idempotency
 * key. Almost no agent-referrals route accepts one (see the audit in this
 * PR's description); partner commands are instead made safe by single-use
 * step-up grants and by state machines that refuse a second application.
 * Adding a key where the server ignores it would be decoration that reads
 * like a guarantee.
 */
export function usePartnerMutation<TVariables, TData = unknown>(
  mutation: PartnerMutation,
  mutationFn: (variables: TVariables) => Promise<TData>,
  options: {
    context?: (variables: TVariables, data?: TData) => PartnerMutationContext;
  } & Omit<UseMutationOptions<TData, PartnerApiError, TVariables>, "mutationFn" | "onSuccess"> = {},
) {
  const queryClient = useQueryClient();
  const { context, onError, ...rest } = options;
  const invalidate = async (variables: TVariables, data?: TData) => {
    const ctx = context?.(variables, data) ?? {};
    const keys = partnerInvalidationKeysFor(mutation, ctx);
    await Promise.all(keys.map((key) => queryClient.invalidateQueries({ queryKey: key })));
  };
  return useMutation<TData, PartnerApiError, TVariables>({
    ...rest,
    mutationFn,
    retry: 0,
    onSuccess: async (data, variables) => {
      await invalidate(variables, data);
    },
    onError: async (error, variables, onMutateResult, mutationContext) => {
      if (shouldRefreshAuthoritativeState(error)) await invalidate(variables);
      await onError?.(error, variables, onMutateResult, mutationContext);
    },
  });
}
