import {
  isAnalyticsEligibleRoute,
  safeAnalyticsLocation,
} from "@/lib/analytics-location";
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
export type MetrikaQueue = ((...command: MetrikaCommand) => void) & {
  a?: MetrikaCommand[];
  l?: number;
};
export type MetrikaQueueWindow = {
  ym?: MetrikaQueue;
};
type BrowserMetrikaWindow = Window & MetrikaQueueWindow & {
  [key: string]: unknown;
};

const METRIKA_COOKIE_NAMES = [
  "_ym_metrika_enabled",
  "_ym_isad",
  "_ym_uid",
  "_ym_fa",
  "_ym_d",
  "_ym_ucs",
  "_ym_hostIndex",
] as const;

const metrikaLocalStorageKeys = (counterId: number) => [
  `_ym${counterId}_lastHit`,
  `_ym${counterId}_lsid`,
  `_ym${counterId}_reqNum`,
  "_ym_retryReqs",
  "_ym_uid",
  "_ym_hide_phones",
  "zz",
];

export type MetrikaEnvironment = {
  injectTag: (handlers: { onload: () => void; onerror: () => void }) => void;
  setDisabled: (counterId: number, disabled: boolean) => void;
  command: (...command: MetrikaCommand) => void;
  cleanup: (counterId: number) => void;
};

export type MetrikaStorage = {
  removeCookie: (name: string) => void;
  removeLocalStorage: (key: string) => void;
};

/** Removes only documented, first-party Metrika state; never app cookies. */
export function clearMetrikaFirstPartyStorage(
  counterId: number,
  storage: MetrikaStorage,
) {
  for (const name of METRIKA_COOKIE_NAMES) storage.removeCookie(name);
  for (const key of metrikaLocalStorageKeys(counterId)) storage.removeLocalStorage(key);
}

export function installMetrikaQueue(
  browserWindow: MetrikaQueueWindow,
  now = Date.now(),
) {
  if (browserWindow.ym) return browserWindow.ym;
  const queue = ((...command: MetrikaCommand) => {
    queue.a ??= [];
    queue.a.push(command);
  }) as MetrikaQueue;
  queue.l = now;
  browserWindow.ym = queue;
  return queue;
}

function removeBrowserCookie(name: string) {
  const expires = `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
  document.cookie = expires;
  // Metrika may have set a first-party cookie for the public registrable
  // domain. These explicit variants avoid a broad domain/prefix deletion.
  document.cookie = `${expires}; Domain=flexperiment.ru`;
  document.cookie = `${expires}; Domain=.flexperiment.ru`;
}

export function browserMetrikaEnvironment(): MetrikaEnvironment {
  const browserWindow = window as unknown as BrowserMetrikaWindow;

  return {
    injectTag: ({ onload, onerror }) => {
      installMetrikaQueue(browserWindow);
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
    cleanup: (counterId) => clearMetrikaFirstPartyStorage(counterId, {
      removeCookie: removeBrowserCookie,
      removeLocalStorage: (key) => window.localStorage.removeItem(key),
    }),
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
  let cleanupPerformed = false;
  let latestLocation: string | null = null;
  let lastHit: string | null = null;

  const sendLatestHit = () => {
    if (!wanted || !initialized || !latestLocation || latestLocation === lastHit) return;
    lastHit = latestLocation;
    environment.command(counterId, "hit", latestLocation);
  };

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

  const suspend = () => {
    wanted = false;
    environment.setDisabled(counterId, true);
    if (initialized) {
      initialized = false;
      environment.command(counterId, "destruct");
    }
    latestLocation = null;
    lastHit = null;
  };

  return {
    enable() {
      wanted = true;
      cleanupPerformed = false;
      environment.setDisabled(counterId, false);
      if (tagState === "LOADED") initialize();
      else loadTag();
    },
    suspend,
    revoke() {
      suspend();
      if (!cleanupPerformed) {
        cleanupPerformed = true;
        environment.cleanup(counterId);
      }
    },
    observe(pathname: string, search: string) {
      latestLocation = safeAnalyticsLocation(pathname, search);
      sendLatestHit();
    },
  };
}

type MetrikaManager = ReturnType<typeof createMetrikaManager>;

/** Route gate used before creating a manager or inserting a third-party tag. */
export function syncMetrikaForRoute(input: {
  consent: AnalyticsConsent;
  counterId: number | null;
  manager: MetrikaManager | null;
  createManager: (counterId: number) => MetrikaManager;
  pathname: string;
  search: string;
}) {
  const { consent, counterId, manager, createManager, pathname, search } = input;
  if (!isAnalyticsEligibleRoute(pathname)) {
    manager?.suspend();
    return manager;
  }
  if (!canBootstrapMetrika(consent, counterId)) {
    manager?.suspend();
    return manager;
  }
  const active = manager ?? createManager(counterId);
  active.enable();
  active.observe(pathname, search);
  return active;
}
