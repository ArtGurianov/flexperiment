const required = (environment: NodeJS.ProcessEnv, name: string) => {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required runtime configuration: ${name}`);
  return value;
};

export type TochkaConfig = {
  baseUrl: string;
  jwt: string;
  /** Required for production JWT/webhook configuration; absent in Tochka sandbox. */
  clientId?: string;
  customerCode: string;
  merchantId: string;
  taxSystemCode: "usn_income";
  vatType: "none";
};

export const tochkaConfigFromEnvironment = (environment = process.env): TochkaConfig => {
  const baseUrl = required(environment, "TOCHKA_API_BASE_URL").replace(/\/$/, "");
  if (baseUrl !== "https://enter.tochka.com/uapi" && baseUrl !== "https://enter.tochka.com/sandbox/v2") throw new Error("TOCHKA_API_BASE_URL must be the approved production or sandbox endpoint.");
  const taxSystemCode = required(environment, "TOCHKA_TAX_SYSTEM_CODE");
  const vatType = required(environment, "TOCHKA_VAT_TYPE");
  if (taxSystemCode !== "usn_income" || vatType !== "none") throw new Error("The frozen Tochka fiscal profile requires usn_income and none.");
  const clientId = environment.TOCHKA_CLIENT_ID?.trim() || undefined;
  if (baseUrl === "https://enter.tochka.com/uapi" && !clientId) throw new Error("Missing required runtime configuration: TOCHKA_CLIENT_ID");
  return { baseUrl, jwt: required(environment, "TOCHKA_JWT"), clientId, customerCode: required(environment, "TOCHKA_CUSTOMER_CODE"), merchantId: required(environment, "TOCHKA_MERCHANT_ID"), taxSystemCode, vatType };
};

export type UnisenderGoConfig = { apiKey: string; fromEmail: string; fromName: string; replyToEmail: string };
export const unisenderGoConfigFromEnvironment = (environment = process.env): UnisenderGoConfig => ({
  apiKey: required(environment, "UNISENDER_GO_API_KEY"), fromEmail: required(environment, "UNISENDER_GO_FROM_EMAIL"), fromName: required(environment, "UNISENDER_GO_FROM_NAME"), replyToEmail: required(environment, "UNISENDER_GO_REPLY_TO_EMAIL"),
});
