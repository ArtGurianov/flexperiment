const DEFAULT_PUBLIC_MEDIA_URL = "https://flexperiment.s3.cloud.ru";

const encodePath = (value: string) => {
  const segments = value.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("PUBLIC_MEDIA_PATH_INVALID");
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
};

export function publicMediaBaseURL(value = process.env.S3_PUBLIC_URL): URL {
  const url = new URL(value?.trim() || DEFAULT_PUBLIC_MEDIA_URL);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("S3_PUBLIC_URL_INVALID");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

export function publicMediaFileURL({ filename, prefix }: { filename: string; prefix?: string }): string {
  const baseURL = publicMediaBaseURL();
  const objectPath = [prefix, filename].filter((part): part is string => Boolean(part)).join("/");
  return new URL(encodePath(objectPath), baseURL).toString();
}

export function publicMediaRemotePattern() {
  const url = publicMediaBaseURL();
  return {
    protocol: "https" as const,
    hostname: url.hostname,
    port: url.port,
    pathname: `${url.pathname}**`,
    search: "",
  };
}

export function publicImageContentSecurityPolicy(): string {
  return `img-src 'self' data: blob: ${publicMediaBaseURL().origin} https://mc.yandex.ru;`;
}
