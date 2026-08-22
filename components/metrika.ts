import { safeAnalyticsLocation } from "@/lib/analytics-location";
import type { AnalyticsConsent } from "@/lib/analytics-consent";

export const METRIKA_TAG_URL = "https://mc.yandex.ru/metrika/tag.js";

export function metrikaCounterId(value = process.env.NEXT_PUBLIC_YANDEX_METRIKA_ID) {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const counterId = Number(value);
  return Number.isSafeInteger(counterId) ? counterId : null;
}

export function canBootstrapMetrika(
  consent: AnalyticsConsent,
  counterId: number | null,
): counterId is number {
  return consent === "ALLOWED" && counterId !== null;
}

type MetrikaCommand = [number, "init" | "hit" | "destruct", ...unknown[]];
type MetrikaQueue = ((...command: MetrikaCommand) => void) & {
  a?: MetrikaCommand[];
};
type BrowserMetrikaWindow = Window & {
  ym?: MetrikaQueue;
  [key: string]: unknown;
};

export type MetrikaEnvironment = {
  injectTag: (handlers: { onload: () => void; onerror: () => void }) => void;
  setDisabled: (counterId: number, disabled: boolean) => void;
  command: (...command: MetrikaCommand) => void;
};

export function browserMetrikaEnvironment(): MetrikaEnvironment {
  const browserWindow = window as unknown as BrowserMetrikaWindow;

  return {
    injectTag: ({ onload, onerror }) => {
      if (!browserWindow.ym) {
        const queue = ((...command: MetrikaCommand) => {
          queue.a ??= [];
          queue.a.push(command);
        }) as MetrikaQueue;
        browserWindow.ym = queue;
      }
      const script = document.createElement("script");
      script.async = true;
      script.src = METRIKA_TAG_URL;
      script.onload = onload;
      script.onerror = onerror;
      document.head.append(script);
    },
    setDisabled: (counterId, disabled) => {
      browserWindow[`disableYaCounter${counterId}`] = disabled;
    },
    command: (...command) => browserWindow.ym?.(...command),
  };
}

/**
 * Owns the one live counter instance in a browser document. It knows nothing
 * about application data: callers can provide only a sanitized page address.
 */
export function createMetrikaManager(
  counterId: number,
  environment: MetrikaEnvironment,
) {
  let wanted = false;
  let tagState: "IDLE" | "LOADING" | "LOADED" = "IDLE";
  let initialized = false;
  let latestLocation: string | null = null;
  let lastHit: string | null = null;

  const initialize = () => {
    if (!wanted || tagState !== "LOADED" || initialized) return;
    initialized = true;
    environment.command(counterId, "init", {
      defer: true,
      webvisor: false,
      clickmap: false,
      trackLinks: false,
      sendTitle: false,
    });
    sendLatestHit();
  };

  const sendLatestHit = () => {
    if (!wanted || !initialized || !latestLocation || latestLocation === lastHit) return;
    lastHit = latestLocation;
    environment.command(counterId, "hit", latestLocation);
  };

  const loadTag = () => {
    if (tagState !== "IDLE") return;
    tagState = "LOADING";
    environment.injectTag({
      onload: () => {
        tagState = "LOADED";
        initialize();
      },
      onerror: () => {
        tagState = "IDLE";
      },
    });
  };

  return {
    enable() {
      wanted = true;
      environment.setDisabled(counterId, false);
      if (tagState === "LOADED") initialize();
      else loadTag();
    },
    disable() {
      wanted = false;
      environment.setDisabled(counterId, true);
      if (initialized) {
        initialized = false;
        environment.command(counterId, "destruct");
      }
      lastHit = null;
    },
    observe(pathname: string, search: string) {
      latestLocation = safeAnalyticsLocation(pathname, search);
      sendLatestHit();
    },
  };
}
