"use client";

import Link from "next/link";
import MiniSearch from "minisearch";
import { useEffect, useMemo, useState } from "react";
import { parsePublicSearchIndex, type PublicSearchIndexEntry } from "@/lib/public-search";

const normalize = (term: string) => term.toLocaleLowerCase("ru-RU").replaceAll("ё", "е");

export default function CourseSearch() {
  const [documents, setDocuments] = useState<PublicSearchIndexEntry[]>([]);
  const [query, setQuery] = useState("");
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/search-index.json", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("SEARCH_UNAVAILABLE");
        return response.json() as Promise<unknown>;
      })
      .then((body) => setDocuments(parsePublicSearchIndex(body)))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setUnavailable(true);
      });
    return () => controller.abort();
  }, []);

  const index = useMemo(() => {
    const next = new MiniSearch<PublicSearchIndexEntry>({
      fields: ["title", "summary"],
      storeFields: ["type", "ref", "title", "summary", "url"],
      idField: "ref",
      processTerm: normalize,
    });
    next.addAll(documents);
    return next;
  }, [documents]);

  const results = query.trim().length < 2
    ? []
    : index.search(query, { prefix: true, fuzzy: 0.2 }).slice(0, 12) as unknown as PublicSearchIndexEntry[];

  return <section className="courseSearch" aria-labelledby="course-search-title">
    <label id="course-search-title" htmlFor="course-search">Поиск по курсам и урокам</label>
    <div className="searchInput"><span aria-hidden="true">⌕</span><input id="course-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Например, импровизация" autoComplete="off" /></div>
    {unavailable && <p className="searchHint" role="status">Поиск временно недоступен. Каталог ниже продолжает работать.</p>}
    {query.trim().length >= 2 && !unavailable && <div className="searchResults" aria-live="polite">
      {results.map((result) => <Link href={result.url} key={`${result.type}:${result.ref}`}><small>{result.type === "course" ? "Курс" : "Урок"}</small><strong>{result.title}</strong><span>{result.summary}</span></Link>)}
      {results.length === 0 && <p className="searchHint">Ничего не найдено.</p>}
    </div>}
  </section>;
}
