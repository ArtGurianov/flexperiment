import { useMutation, useQueryClient, type UseMutationOptions } from "@tanstack/react-query";
import { type AdminApiError } from "./api";
import { shouldRefreshAuthoritativeState } from "./idempotency";
import { invalidationKeysFor, type AdminMutation, type MutationContext } from "./invalidation";

/**
 * The only sanctioned way to mutate admin state. No component may call
 * queryClient.invalidateQueries directly — that is exactly how A1/A2's
 * divergent, forgettable wiring grows back. This wrapper awaits every
 * invalidation inside onSuccess, which is also what keeps isPending true
 * until the refetch completes (fixing the submit button's premature
 * not-busy state).
 */
export function useAdminMutation<TVariables, TData = unknown>(
  mutation: AdminMutation,
  mutationFn: (variables: TVariables) => Promise<TData>,
  options: {
    context?: (variables: TVariables, data?: TData) => MutationContext;
  } & Omit<UseMutationOptions<TData, AdminApiError, TVariables>, "mutationFn" | "onSuccess"> = {},
) {
  const queryClient = useQueryClient();
  const { context, onError, ...rest } = options;
  const invalidate = async (variables: TVariables, data?: TData) => {
    const ctx = context?.(variables, data) ?? {};
    const keys = invalidationKeysFor(mutation, ctx);
    await Promise.all(keys.map((key) => queryClient.invalidateQueries({ queryKey: key })));
  };
  return useMutation<TData, AdminApiError, TVariables>({
    ...rest,
    mutationFn,
    retry: 0,
    onSuccess: async (data, variables) => {
      await invalidate(variables, data);
    },
    onError: async (error, variables, onMutateResult, mutationContext) => {
      // An ambiguous result and an idempotency conflict are not a licence to
      // mint a fresh key. Refresh the records the command could have changed;
      // a replay with the retained key is then safe and deterministic.
      if (shouldRefreshAuthoritativeState(error)) await invalidate(variables);
      await onError?.(error, variables, onMutateResult, mutationContext);
    },
  });
}
