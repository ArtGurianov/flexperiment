import {
  isAnalyticsEligibleRoute,
  safeAnalyticsLocation,
} from "@/lib/analytics-location";
import type { AnalyticsConsent } from "@/lib/analytics-consent";

export const METRIKA_TAG_URL = "https://mc.yandex.ru/metrika/tag.js";
/** Public counter identifier; it is not a credential or a user identifier. */
export const METRIKA_COUNTER_ID = 111866892;

export function metrikaCounterId(value = String(METRIKA_COUNTER_ID)) {
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

export type MetrikaGoalName =
  | "city_view"
  | "checkout_start"
  | "promo_applied"
  | "promo_rejected"
  | "payment_redirect"
  | "purchase_success"
  | "payment_failed";

type MetrikaCommand = [number, "init" | "hit" | "reachGoal" | "destruct", ...unknown[]];
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

const METRIKA_GENERIC_LOCAL_STORAGE_KEYS = [
  "_ym_retryReqs",
  "_ym_uid",
  "_ym_hide_phones",
  "zz",
] as const;

const METRIKA_SESSION_STORAGE_KEYS = [
  "_ym_debugger_state",
  "_ym_turbo_uid",
] as const;

export type MetrikaEnvironment = {
  injectTag: (handlers: { onload: () => void; onerror: () => void }) => void;
  setDisabled: (counterId: number, disabled: boolean) => void;
  command: (...command: MetrikaCommand) => void;
  cleanup: (counterId: number | null) => void;
};

export type MetrikaStorage = {
  removeCookie: (name: string) => void;
  removeLocalStorage: (key: string) => void;
  removeSessionStorage: (key: string) => void;
};

/** Removes only documented, first-party Metrika state; never app cookies. */
export function clearMetrikaFirstPartyStorage(
  counterId: number | null,
  storage: MetrikaStorage,
) {
  for (const name of METRIKA_COOKIE_NAMES) storage.removeCookie(name);
  for (const key of METRIKA_GENERIC_LOCAL_STORAGE_KEYS) storage.removeLocalStorage(key);
  if (counterId !== null) {
    for (const key of metrikaLocalStorageKeys(counterId).slice(0, 3)) {
      storage.removeLocalStorage(key);
    }
  }
  for (const key of METRIKA_SESSION_STORAGE_KEYS) storage.removeSessionStorage(key);
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

function browserMetrikaStorage(): MetrikaStorage {
  return {
    removeCookie: removeBrowserCookie,
    removeLocalStorage: (key) => window.localStorage.removeItem(key),
    removeSessionStorage: (key) => window.sessionStorage.removeItem(key),
  };
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
    cleanup: (counterId) => clearMetrikaFirstPartyStorage(counterId, browserMetrikaStorage()),
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
    /**
     * The current privacy contract intentionally permits no arbitrary event
     * parameters: future callers can emit only a reviewed goal name after the
     * counter is initialized and consent remains in force.
     */
    reachGoal(name: MetrikaGoalName) {
      if (!wanted || !initialized) return;
      environment.command(counterId, "reachGoal", name);
    },
  };
}

type MetrikaManager = ReturnType<typeof createMetrikaManager>;

export type MetrikaDenialEnvironment = Pick<
  MetrikaEnvironment,
  "setDisabled" | "cleanup"
>;

/**
 * Enforces a0 without constructing Metrika. This is intentionally separate
 * from the manager because sensitive routes never create one.
 */
export function enforceMetrikaDenied(input: {
  counterId: number | null;
  manager: MetrikaManager | null;
  environment: MetrikaDenialEnvironment;
}) {
  const { counterId, manager, environment } = input;
  if (manager) {
    manager.revoke();
    return;
  }
  if (counterId !== null) environment.setDisabled(counterId, true);
  environment.cleanup(counterId);
}

export function browserMetrikaDenialEnvironment(): MetrikaDenialEnvironment {
  const browserWindow = window as unknown as BrowserMetrikaWindow;
  return {
    setDisabled: (counterId, disabled) => {
      browserWindow[`disableYaCounter${counterId}`] = disabled;
    },
    cleanup: (counterId) => clearMetrikaFirstPartyStorage(counterId, browserMetrikaStorage()),
  };
}

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
