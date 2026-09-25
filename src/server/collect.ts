import Parser from "rss-parser";
import { GoogleGenAI } from "@google/genai";
import { SOURCES } from "./sources.js";
import type { Article, Cat } from "./types.js";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export const extractImgs = (html: string, base?: string): string[] =>
  [...html.matchAll(/<img[^>]+(?:data-src|src)=["']([^"']+)["']/gi)]
    .map((m) => {
      try {
        return new URL(m[1], base).href;
      } catch {
        return "";
      }
    })
    .filter(
      (u) =>
        u &&
        !/logo|avatar|icon|emoji|sprite|gravatar|pixel|banner|ads?\/|\.svg/i.test(u)
    );

const parser = new Parser({
  timeout: 12000,
  headers: { "User-Agent": UA },
  customFields: {
    item: [
      ["media:content", "media"],
      ["media:thumbnail", "thumb"],
      ["content:encoded", "encoded"],
      ["category", "atomCats", { keepArray: true }],
    ],
  },
});

async function fromRss(
  s: Extract<(typeof SOURCES)[number], { kind: "rss" }>
): Promise<Article[]> {
  const feed = await parser.parseURL(s.url);
  const re = s.filter ? new RegExp(s.filter, "i") : null;
  return feed.items
    .filter((it: any) => {
      if (!re) return true;
      const cats = [
        ...(it.categories ?? []),
        ...(it.atomCats ?? []).map((c: any) => c?.$?.term ?? c?.$?.label ?? c),
      ]
        .filter((x: any) => typeof x === "string")
        .join(" ");
      return re.test(`${it.title} ${cats}`);
    })
    .map((it: any) => ({
      title: (it.title || "").trim(),
      link: it.link || "",
      date: Date.parse(it.isoDate || it.pubDate || "") || Date.now(),
      snippet: (it.contentSnippet || it.summary || "").slice(0, 300),
      source: s.name,
      cat: s.cat,
      images: [
        it.enclosure?.url,
        it.media?.$?.url,
        it.thumb?.$?.url,
        ...extractImgs(it.encoded || it.content || "", it.link),
      ].filter(Boolean) as string[],
    }));
}

async function fromReddit(
  s: Extract<(typeof SOURCES)[number], { kind: "reddit" }>
): Promise<Article[]> {
  const res = await fetch(
    `https://www.reddit.com/r/${s.sub}/top.json?t=day&limit=25`,
    {
      headers: { "User-Agent": "subcul-mag/1.0 (subculture news monitor)" },
      signal: AbortSignal.timeout(10000),
    }
  );
  if (res.ok) {
    const json: any = await res.json();
    return (json.data?.children ?? [])
      .map((c: any) => c.data)
      .filter((d: any) => !d.stickied)
      .map((d: any) => ({
        title: d.title,
        link: `https://www.reddit.com${d.permalink}`,
        date: (d.created_utc || Date.now() / 1000) * 1000,
        snippet: (d.selftext || d.url_overridden_by_dest || "").slice(0, 300),
        source: `Reddit r/${s.sub}`,
        cat: s.cat,
        score: d.score,
        images: (d.preview?.images ?? [])
          .map((i: any) => (i.source?.url || "").replace(/&amp;/g, "&"))
          .filter(Boolean),
      }));
  }
  // 클라우드 IP 차단(403/429)이면 RSS로 한 번 더 시도
  const feed = await parser.parseURL(`https://www.reddit.com/r/${s.sub}/top/.rss?t=day`);
  return feed.items.map((it: any) => ({
    title: (it.title || "").trim(),
    link: it.link || "",
    date: Date.parse(it.isoDate || "") || Date.now(),
    snippet: (it.contentSnippet || "").slice(0, 300),
    source: `Reddit r/${s.sub}`,
    cat: s.cat,
    images: extractImgs(it.content || "", it.link),
  }));
}

// X 트렌드 및 최신 화제: Gemini + Google Search Grounding (쿼터 보호 캐시 탑재)
let cachedXTrends: Article[] = [];
let lastXTrendsFetch = 0;
let xTrendsQuotaCooldownUntil = 0;

export async function fromXTrends(
  ai: GoogleGenAI,
  model: string,
  log?: (m: string) => void
): Promise<Article[]> {
  const now = Date.now();

  // 1시간 내 캐시가 있거나, 쿼터 제한 쿨다운 상태인 경우 API 호출 없이 캐시 반환
  if (now < xTrendsQuotaCooldownUntil || (cachedXTrends.length > 0 && now - lastXTrendsFetch < 60 * 60 * 1000)) {
    return cachedXTrends;
  }

  try {
    const res = await ai.models.generateContent({
      model,
      contents: `최근 24시간 동안 X(트위터) 일본·한국·영미권에서 화제가 된 애니메이션/서브컬처 게임/J-POP 공식 발표 뉴스 6~8개를 조사하여 순수 JSON 배열만 출력하세요:
[
  {
    "title": "뉴스 제목(한국어 또는 원문)",
    "url": "해당 소식 링크(공식 X 또는 뉴스 URL)",
    "cat": "anime 또는 game 또는 jpop",
    "summary": "1~2문장 요약"
  }
]`,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const txt = (res.text ?? "").replace(/```json|```/g, "").trim();
    const startIdx = txt.indexOf("[");
    const endIdx = txt.lastIndexOf("]");
    if (startIdx === -1 || endIdx === -1) return cachedXTrends;

    const arr = JSON.parse(txt.slice(startIdx, endIdx + 1));
    const items = (arr ?? []).map((a: any) => ({
      title: a.title || "X 실시간 트렌드 화제 소식",
      link: a.url || `https://x.com/search?q=${encodeURIComponent(a.title || "")}`,
      date: Date.now(),
      snippet: a.summary || "",
      source: "X 트렌드 (실시간 탐색)",
      cat: (["anime", "game", "jpop"].includes(a.cat) ? a.cat : "anime") as Cat,
      images: [],
    }));

    if (items.length > 0) {
      cachedXTrends = items;
      lastXTrendsFetch = now;
    }
    return cachedXTrends;
  } catch (err: any) {
    const isQuotaError =
      err.message?.includes("429") ||
      err.message?.includes("RESOURCE_EXHAUSTED") ||
      err.message?.includes("quota");

    if (isQuotaError) {
      // 1시간 동안 쿼터 보호 모드로 전환하여 재호출 차단
      xTrendsQuotaCooldownUntil = Date.now() + 60 * 60 * 1000;
      log?.("💡 X 트렌드: Gemini 검색 쿼터 절약을 위해 RSS 및 커뮤니티 소스 중심으로 자동 전환되었습니다.");
    } else {
      console.warn("X 트렌드 수집 안내:", err.message);
    }
    return cachedXTrends;
  }
}

import { translateArticlesToKorean } from "./translate.js";

const seen = new Set<string>();
export const markUsed = (link: string) => seen.add(link);

export async function collectAll(
  ai: GoogleGenAI,
  model: string,
  maxAgeHours: number,
  log: (msg: string) => void
): Promise<Article[]> {
  log("📡 서브컬처 뉴스 수집을 시작합니다 (RSS / Reddit / X)...");

  const tasks: Promise<Article[]>[] = SOURCES.map((s) =>
    (s.kind === "rss" ? fromRss(s) : fromReddit(s))
      .then((items) => {
        log(`✔ ${s.name}: ${items.length}건 수집 완료`);
        return items;
      })
      .catch((e) => {
        log(`✖ ${s.name}: ${e.message}`);
        return [] as Article[];
      })
  );

  tasks.push(
    fromXTrends(ai, model, log)
      .then((items) => {
        if (items.length) log(`✔ X 트렌드 검색: ${items.length}건 수집 완료`);
        return items;
      })
      .catch(() => [] as Article[])
  );

  const nested = await Promise.all(tasks);
  const all = nested.flat();
  const cutoff = Date.now() - maxAgeHours * 3600_000;
  const norm = (t: string) =>
    t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "").slice(0, 40);

  const dedup = new Map<string, Article>();
  for (const a of all) {
    if (!a.title || !a.link || a.date < cutoff || seen.has(a.link)) continue;
    const k = norm(a.title);
    if (!dedup.has(k)) {
      dedup.set(k, a);
    }
  }

  const result = [...dedup.values()].sort((a, b) => b.date - a.date).slice(0, 60);
  log(`총 ${result.length}건의 중복 없는 최신 기사가 준비되었습니다.`);

  // 한국어 번역 적용
  const translated = await translateArticlesToKorean(ai, model, result, log);
  return translated;
}
