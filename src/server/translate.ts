import { GoogleGenAI } from "@google/genai";
import type { Article } from "./types.js";

// 기사 링크 기준 번역 영구 메모리 캐시
const translationCache = new Map<string, { titleKo: string; snippetKo: string }>();

// 텍스트 기준 캐시 (단일 문장/제목/슬라이드용)
const textTranslationCache = new Map<string, string>();

const FAST_MODELS = ["gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-3.8-flash"];

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const cleaned = (raw || "")
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
    const start = cleaned.indexOf(cleaned.startsWith("[") ? "[" : "{");
    const end = cleaned.lastIndexOf(cleaned.startsWith("[") ? "]" : "}");
    if (start === -1 || end === -1) return fallback;
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return fallback;
  }
}

// 텍스트가 이미 한국어인지 검사 (한글이 3자 이상 포함되어 있는지)
export function isMostlyKorean(text: string): boolean {
  if (!text) return true;
  const hangulMatch = text.match(/[가-힣]/g);
  return (hangulMatch?.length || 0) >= 3;
}

// 일본어(히라가나/가타카나)가 포함되어 있는지 검사
export function containsJapanese(text: string): boolean {
  if (!text) return false;
  return /[\u3040-\u309F\u30A0-\u30FF]/.test(text);
}

// 단일 문장/제목/슬라이드 본문 번역 함수
export async function translateSingleText(
  ai: GoogleGenAI,
  text: string,
  context: "title" | "body" | "slide" = "title"
): Promise<string> {
  const trimmed = (text || "").trim();
  if (!trimmed) return "";
  if (isMostlyKorean(trimmed) && !containsJapanese(trimmed)) {
    return trimmed;
  }

  if (textTranslationCache.has(trimmed)) {
    return textTranslationCache.get(trimmed)!;
  }

  const prompt = `너는 서브컬처(애니메이션, 게임, J-POP) 전문 번역가다.
다음 ${context === "title" ? "제목" : "카드뉴스 문장"}을 한국 2030 독자들이 읽기 가장 자연스러운 100% 한국어로 번역하라.
작품명, 캐릭터명, 게임명은 국내 공식 통용 명칭을 사용하라.
절대로 따옴표나 부가 설명 없이, 오직 번역된 한국어 결과만 텍스트로 출력하라:

${trimmed}`;

  for (const m of FAST_MODELS) {
    try {
      const res = await ai.models.generateContent({
        model: m,
        contents: prompt,
      });
      const translated = (res.text || "").trim().replace(/^["']|["']$/g, "");
      if (translated && isMostlyKorean(translated)) {
        textTranslationCache.set(trimmed, translated);
        return translated;
      }
    } catch {
      continue;
    }
  }

  return trimmed;
}

// 전체 기사 목록 한국어 번역 (병렬 청크 처리)
export async function translateArticlesToKorean(
  ai: GoogleGenAI,
  _model: string,
  articles: Article[],
  log?: (m: string) => void
): Promise<Article[]> {
  const toTranslate: { idx: number; article: Article }[] = [];

  articles.forEach((a, i) => {
    // 1. 이미 캐시된 경우 즉시 복원
    if (translationCache.has(a.link)) {
      const cached = translationCache.get(a.link)!;
      a.titleKo = cached.titleKo;
      a.snippetKo = cached.snippetKo;
      return;
    }

    // 2. 이미 한국어 기사인 경우 번역 스킵
    if (isMostlyKorean(a.title) && !containsJapanese(a.title)) {
      a.titleKo = a.title;
      a.snippetKo = a.snippet;
      translationCache.set(a.link, { titleKo: a.title, snippetKo: a.snippet });
      return;
    }

    toTranslate.push({ idx: i, article: a });
  });

  if (toTranslate.length === 0) {
    return articles;
  }

  // 10개씩 청크 분할하여 병렬(Parallel) 번역 실행
  const BATCH_SIZE = 10;
  const chunks: { idx: number; article: Article }[][] = [];
  for (let i = 0; i < toTranslate.length; i += BATCH_SIZE) {
    chunks.push(toTranslate.slice(i, i + BATCH_SIZE));
  }

  log?.(`🇰🇷 외신 기사 총 ${toTranslate.length}건을 한국어로 일괄 번역합니다 (${chunks.length}개 청크 병렬)...`);

  await Promise.all(
    chunks.map(async (chunk) => {
      const payload = chunk.map((c, localIdx) => ({
        id: localIdx,
        title: c.article.title,
        snippet: (c.article.snippet || "").slice(0, 150),
      }));

      const prompt = `너는 서브컬처(애니메이션, 서브컬처 게임, J-POP) 전문 미디어 번역가다.
아래 외국어(영어/일본어) 기사들의 제목(title)과 요약(snippet)을 한국 독자들에게 가장 자연스럽고 흥미로운 100% 한국어로 번역하라.
작품명, 캐릭터명, 게임명은 국내 공식 통용 명칭을 우선 사용하라.

[입력 목록]
${JSON.stringify(payload, null, 2)}

반드시 아래 형식의 순수 JSON 배열만 출력하세요:
[
  {
    "id": 0,
    "titleKo": "100% 한국어 제목",
    "snippetKo": "100% 한국어 요약 (1~2문장)"
  }
]`;

      for (const m of FAST_MODELS) {
        try {
          const res = await ai.models.generateContent({
            model: m,
            contents: prompt,
            config: { responseMimeType: "application/json" },
          });
          const translatedArr = parseJson<any[]>(res.text || "[]", []);
          if (translatedArr.length > 0) {
            translatedArr.forEach((t) => {
              const item = chunk[t.id];
              if (item && t.titleKo) {
                const titleKo = String(t.titleKo).trim();
                const snippetKo = String(t.snippetKo || item.article.snippet).trim();
                item.article.titleKo = titleKo;
                item.article.snippetKo = snippetKo;
                translationCache.set(item.article.link, { titleKo, snippetKo });
              }
            });
            break; // 성공 시 다음 모델 시도 안 함
          }
        } catch {
          continue;
        }
      }
    })
  );

  // 미번역 항목 원문 안전망
  articles.forEach((a) => {
    if (!a.titleKo) a.titleKo = a.title;
    if (!a.snippetKo) a.snippetKo = a.snippet;
  });

  const translatedCount = articles.filter((a) => isMostlyKorean(a.titleKo || "")).length;
  log?.(`✔ 뉴스 한국어 번역 완료 (${translatedCount}/${articles.length}건 한국어 번역 완료)`);
  return articles;
}
