"use client";

/* FLEX-123 Navbar profile slot, shared by LMS and LAB. Each app wraps it and passes its pathname
 * (no next/* import here: the root lib must not bind to one app's Next.js instance).
 * Rendered only on the client: the public SSR/ISR HTML carries the stable empty slot and never a profile. */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  cabinetLinks, createNavbarSession, signInHref,
  type NavbarConfig, type NavbarState,
} from "./navbar-core";
import styles from "./navbar.module.css";

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export default function NavbarProfile({ config, pathname, fetcher }: {
  config: NavbarConfig; pathname: string | null; fetcher?: Fetcher;
}) {
  const [state, setState] = useState<NavbarState>({ kind: "loading" });
  const [open, setOpen] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const session = useRef<ReturnType<typeof createNavbarSession> | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    const created = createNavbarSession(config, { fetcher, pageOrigin: window.location.origin, onChange: setState });
    session.current = created;
    void created.check();
    const recheck = () => { if (document.visibilityState === "visible") void created.check(); };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
      session.current = null;
    };
  }, [config, fetcher]);

  // A signed-out or unavailable state can never keep an open profile popover.
  const popoverOpen = open && state.kind === "signed-in";

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!popoverOpen) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !panel.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [popoverOpen, close]);

  const toggle = () => {
    if (popoverOpen) { close(false); return; }
    setOpen(true);
    void session.current?.check(); // re-verify on every opening
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && popoverOpen) {
      event.stopPropagation();
      close(true);
    }
  };

  const signOut = async () => {
    setOpen(false);
    setSignOutFailed(false);
    const ok = await session.current?.signOut();
    if (!ok) setSignOutFailed(true);
    trigger.current?.focus();
  };

  const myHome = new URL("/", config.myOrigin).toString();

  return (
    // ym-hide-content / ym-disable-keys: excluded from any session recording (FLEX-123, F's consent layer).
    <div className={`${styles.slot} ym-hide-content ym-disable-keys`} data-analytics-exclude="" onKeyDown={onKeyDown}>
      {state.kind === "loading" && <span className={styles.placeholder} aria-hidden="true" />}

      {state.kind === "guest" && (
        <>
          <a className={styles.action} href={signInHref(config, pathname)}>Войти через my</a>
          {signOutFailed && <span className={styles.note} role="status">Не удалось выйти. Откройте my.</span>}
        </>
      )}

      {state.kind === "unavailable" && (
        <a className={styles.action} href={myHome} target="_blank" rel="noopener noreferrer">
          {signOutFailed ? "Не удалось выйти — открыть my" : "Личный кабинет my"}
        </a>
      )}

      {state.kind === "signed-in" && (
        <>
          <button
            ref={trigger}
            type="button"
            className={styles.action}
            aria-expanded={popoverOpen}
            aria-controls={panelId}
            onClick={toggle}
          >
            {state.profile.displayName ?? "Профиль"}
          </button>
          <div
            ref={panel}
            id={panelId}
            className={styles.popover}
            role="region"
            aria-label="Профиль my"
            hidden={!popoverOpen}
          >
            {popoverOpen && (
              <>
                {state.profile.emailMasked && <p className={styles.email}>{state.profile.emailMasked}</p>}
                <ul className={styles.links}>
                  {cabinetLinks(config.myOrigin).map((link) => (
                    <li key={link.href}>
                      <a href={link.href} target="_blank" rel="noopener noreferrer">{link.label}</a>
                    </li>
                  ))}
                </ul>
                {config.signOutUrl && <button type="button" className={styles.signOut} onClick={signOut}>Выйти</button>}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
