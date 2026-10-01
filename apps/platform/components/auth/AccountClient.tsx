"use client";

import { useEffect, useState, type FormEvent } from "react";

type Me = {
  customer: { id: string; email_normalized: string; display_name?: string | null } | null;
  entitlements?: Array<{ scope: "COURSE" | "ALL_COURSES"; course_ref?: string | null; granted_at: string }>;
};

type AccountCourse = {
  courseRef: string;
  title: string;
  url: string;
  access: "ENTITLED" | "FREE" | "PREVIEW";
  lessons: Array<{
    lessonRef: string;
    title: string;
    sectionTitle: string;
    url: string;
    access: "ENTITLED" | "FREE" | "PREVIEW";
  }>;
};

type AccountOrder = {
  orderPublicId: string;
  state: string;
  amountKopecks: number;
  currency: "RUB";
  title: string;
  offerRef: string;
  productKind: string;
  createdAt: string;
};

type LegalDocument = { kind: string; version: string; sha256: string; url: string };
type LegalRelease = { version: string; manifest: { stage: "A" | "B"; documents: LegalDocument[] } };

const accessLabel = (access: AccountCourse["access"]) => access === "ENTITLED" ? "Ваш доступ" : access === "FREE" ? "Бесплатно" : "Превью";
const money = (kopecks: number) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(kopecks / 100);
const date = (value: string) => new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium" }).format(new Date(value));

declare global {
  interface Window {
    smartCaptcha?: { render: (container: HTMLElement, input: { sitekey: string; hl: "ru"; callback: (token: string) => void }) => number; destroy: (id: number) => void };
  }
}

export default function AccountClient({ nextPath, captchaSiteKey }: { nextPath: string; captchaSiteKey?: string }) {
  const [me, setMe] = useState<Me | null>(null);
  const [courses, setCourses] = useState<AccountCourse[]>([]);
  const [orders, setOrders] = useState<AccountOrder[]>([]);
  const [captchaToken, setCaptchaToken] = useState("");
  const [legalRelease, setLegalRelease] = useState<LegalRelease | null>(null);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void fetch("/v1/me", { cache: "no-store", credentials: "same-origin" })
      .then((response) => response.json()).then((body: Me) => {
        setMe(body);
        if (body.customer) void Promise.all([
          fetch("/account-courses.json", { cache: "no-store", credentials: "same-origin" })
            .then((response) => response.json()) as Promise<{ courses?: AccountCourse[] }>,
          fetch("/v1/me/orders", { cache: "no-store", credentials: "same-origin" })
            .then((response) => response.json()) as Promise<{ orders?: AccountOrder[] }>,
        ]).then(([catalogue, history]) => {
          setCourses(catalogue.courses ?? []);
          setOrders(history.orders ?? []);
        }).catch(() => {
          setCourses([]);
          setOrders([]);
        });
        else void fetch("/v1/legal/current?storefront=COURSES", { cache: "no-store", credentials: "same-origin" })
          .then((response) => {
            if (!response.ok) throw new Error("LEGAL_RELEASE_NOT_FOUND");
            return response.json() as Promise<LegalRelease>;
          })
          .then(setLegalRelease)
          .catch(() => setLegalRelease(null));
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
    const legalByKind = new Map(legalRelease?.manifest.documents.map((item) => [item.kind, item]));
    const personalData = legalByKind.get("personal_data");
    const accountTerms = legalByKind.get("account_terms");
    const marketing = legalByKind.get("marketing_consent");
    if (!personalData || !accountTerms || !marketing) {
      setMessage("Регистрация временно недоступна: не опубликован комплект документов.");
      return;
    }
    setSubmitting(true);
    setMessage("");
    const response = await fetch("/v1/auth/sign-in/magic-link", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: data.get("email"),
        storefront: "COURSES",
        metadata: { storefront: "COURSES" },
        callbackURL: new URL(nextPath, window.location.origin).toString(),
        captchaToken,
        personalDataConsent: data.get("personalDataConsent") === "on",
        personalDataVersion: personalData.version,
        personalDataSha256: personalData.sha256,
        accountTermsVersion: accountTerms.version,
        accountTermsSha256: accountTerms.sha256,
        marketingConsent: data.get("marketingConsent") === "on",
        marketingDocumentVersion: marketing.version,
        marketingDocumentSha256: marketing.sha256,
      }),
    });
    setSubmitting(false);
    setMessage(response.ok ? "Ссылка отправлена. Проверьте почту." : "Не получилось отправить ссылку. Проверьте данные и попробуйте снова.");
  };

  if (me?.customer) return <section className="accountPanel"><p className="eyebrow">Аккаунт · {me.customer.email_normalized}</p><h1>Мои курсы</h1><section className="accountSection" aria-labelledby="available-lessons"><header><span>01</span><h2 id="available-lessons">Можно открыть сейчас</h2></header>{courses.length > 0 ? <div className="accountCourses">{courses.map((course) => <article key={course.courseRef}><div><p>{accessLabel(course.access)}</p><h3><a href={course.url}>{course.title}</a></h3></div><ol>{course.lessons.map((lesson) => <li key={lesson.lessonRef}><span>{lesson.sectionTitle}</span><a href={lesson.url}>{lesson.title}</a><small>{accessLabel(lesson.access)}</small></li>)}</ol></article>)}</div> : <p className="emptyState">Доступных уроков пока нет. Бесплатные и preview-уроки появятся здесь после публикации.</p>}</section><section className="accountSection" aria-labelledby="purchase-history"><header><span>02</span><h2 id="purchase-history">История покупок</h2></header>{orders.length > 0 ? <ol className="purchaseHistory">{orders.map((order) => <li key={order.orderPublicId}><div><strong>{order.title}</strong><span>{order.orderPublicId}</span></div><div><strong>{money(order.amountKopecks)}</strong><span>{date(order.createdAt)} · {order.state}</span></div></li>)}</ol> : <p className="emptyState">Покупок пока нет.</p>}</section></section>;

  const legalByKind = new Map(legalRelease?.manifest.documents.map((item) => [item.kind, item]));
  const privacy = legalByKind.get("privacy");
  const personalData = legalByKind.get("personal_data");
  const accountTerms = legalByKind.get("account_terms");
  const marketing = legalByKind.get("marketing_consent");
  const legalReady = Boolean(privacy && personalData && accountTerms && marketing);
  return <section className="accountPanel"><p className="eyebrow">Вход без пароля</p><h1>Мои курсы</h1><form className="authForm" onSubmit={submit}><label>Электронная почта<input required name="email" type="email" autoComplete="email" /></label><label className="check"><input required name="personalDataConsent" type="checkbox" />Согласен с <a href={personalData?.url} target="_blank" rel="noreferrer">обработкой персональных данных</a>, <a href={accountTerms?.url} target="_blank" rel="noreferrer">условиями аккаунта</a> и ознакомлен с <a href={privacy?.url} target="_blank" rel="noreferrer">политикой конфиденциальности</a></label><label className="check"><input name="marketingConsent" type="checkbox" />Хочу получать новости о курсах по <a href={marketing?.url} target="_blank" rel="noreferrer">условиям рассылки</a></label>{captchaSiteKey && <div id="smartcaptcha-account" className="smartCaptcha" />}<button className="primary" disabled={submitting || !legalReady || Boolean(captchaSiteKey && !captchaToken)} type="submit">{submitting ? "Отправляем…" : legalReady ? "Получить ссылку →" : "Документы не опубликованы"}</button>{message && <p role="status">{message}</p>}</form></section>;
}
