const configuredBaseUrl = process.env.NEXT_PUBLIC_COMMERCE_API_URL ?? "https://api.flexperiment.ru";

export const commerceApiUrl = (path: string) => {
  if (!path.startsWith("/")) throw new Error("Commerce API paths must begin with '/'.");
  return `${configuredBaseUrl.replace(/\/+$/, "")}${path}`;
};
