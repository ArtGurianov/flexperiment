"use client";

import { useEffect, useState, type FormEvent } from "react";

type Me = {
  customer: { id: string; email_normalized: string; display_name?: string | null } | null;
  entitlements?: Array<{ scope: "COURSE" | "ALL_COURSES"; course_ref?: string | null; granted_at: string }>;
};

type AccountCourse = { courseRef: string; title: string; url: string };

declare global {
  interface Window {
    smartCaptcha?: { render: (container: HTMLElement, input: { sitekey: string; hl: "ru"; callback: (token: string) => void }) => number; destroy: (id: number) => void };
  }
}

export default function AccountClient({ nextPath, captchaSiteKey }: { nextPath: string; captchaSiteKey?: string }) {
  const [me, setMe] = useState<Me | null>(null);
  const [courses, setCourses] = useState<AccountCourse[]>([]);
  const [captchaToken, setCaptchaToken] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void fetch("/v1/me", { cache: "no-store", credentials: "same-origin" })
      .then((response) => response.json()).then((body: Me) => {
        setMe(body);
        if (body.customer) void fetch("/account-courses.json", { cache: "no-store", credentials: "same-origin" })
          .then((response) => response.json())
          .then((catalogue: { courses?: AccountCourse[] }) => setCourses(catalogue.courses ?? []))
          .catch(() => setCourses([]));
      }).catch(() => setMe({ customer: null }));
  }, []);

  useEffect(() => {
    if (!captchaSiteKey) return;
    let widgetId: number | undefined;
    const container = document.getElementById("smartcaptcha-account");
    const render = () => {
      if (container && window.smartCaptcha) widgetId = window.smartCaptcha.render(container, { sitekey: captchaSiteKey, hl: "ru", callback: setCaptchaToken });
    };
    if (window.smartCaptcha) render();
    else {
      const script = document.createElement("script");
      script.src = "https://smartcaptcha.cloud.yandex.ru/captcha.js?render=onload";
      script.async = true;
      script.defer = true;
      script.addEventListener("load", render);
      document.head.append(script);
    }
    return () => { if (widgetId !== undefined) window.smartCaptcha?.destroy(widgetId); };
  }, [captchaSiteKey]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setSubmitting(true);
    setMessage("");
    const response = await fetch("/v1/auth/sign-in/magic-link", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: data.get("email"), callbackURL: nextPath,
        captchaToken,
        personalDataConsent: data.get("personalDataConsent") === "on",
        personalDataVersion: "privacy-stage-a-v1",
        accountTermsVersion: "account-stage-a-v1",
        marketingConsent: data.get("marketingConsent") === "on",
        marketingDocumentVersion: "marketing-stage-a-v1",
      }),
    });
    setSubmitting(false);
    setMessage(response.ok ? "Ссылка отправлена. Проверьте почту." : "Не получилось отправить ссылку. Проверьте данные и попробуйте снова.");
  };

  if (me?.customer) return <section className="accountPanel"><p className="eyebrow">Аккаунт</p><h1>Мои курсы</h1><p>{me.customer.email_normalized}</p>{courses.length > 0 && <ul>{courses.map((course) => <li key={course.courseRef}><a href={course.url}>{course.title}</a></li>)}</ul>}{courses.length === 0 && (me.entitlements ?? []).length > 0 && <p>Доступы активны. Опубликованные курсы появятся здесь после синхронизации каталога.</p>}{(me.entitlements ?? []).length === 0 && <p>Покупок пока нет. Бесплатные уроки открываются после входа.</p>}</section>;

  return <section className="accountPanel"><p className="eyebrow">Вход без пароля</p><h1>Мои курсы</h1><form className="authForm" onSubmit={submit}><label>Электронная почта<input required name="email" type="email" autoComplete="email" /></label><label className="check"><input required name="personalDataConsent" type="checkbox" />Согласен с обработкой персональных данных и условиями аккаунта</label><label className="check"><input name="marketingConsent" type="checkbox" />Хочу получать новости о курсах</label>{captchaSiteKey && <div id="smartcaptcha-account" className="smartCaptcha" />}<button className="primary" disabled={submitting || Boolean(captchaSiteKey && !captchaToken)} type="submit">{submitting ? "Отправляем…" : "Получить ссылку →"}</button>{message && <p role="status">{message}</p>}</form></section>;
}
