/** Check explicit, separate actions before CAPTCHA dispatch, persistence or email. */
export function assertRegistrationChoices(input: { personalDataConsent?: unknown; accountTermsAccepted?: unknown }) {
  if (input.personalDataConsent !== true) throw new Error("PERSONAL_DATA_CONSENT_REQUIRED");
  if (input.accountTermsAccepted !== true) throw new Error("ACCOUNT_TERMS_ACCEPTANCE_REQUIRED");
}
