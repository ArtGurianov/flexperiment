/** A business refusal requiring a new preview or an existing order, never a blind retry. */
export class CheckoutConflictError extends Error {
  constructor(code: string, readonly orderPublicId?: string) {
    super(code);
  }
}
