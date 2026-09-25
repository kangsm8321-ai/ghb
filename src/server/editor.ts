import { GoogleGenAI } from "@google/genai";
import type { Article, Topic, SlideContent } from "./types.js";
import {
  translateSingleText,
  isMostlyKorean,
  containsJapanese,
} from "./translate.js";

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

async function generateContentWithFallback(
  ai: GoogleGenAI,
  primaryModel: string,
  params: { contents: string; config?: any }
) {
  const candidateModels = [
    primaryModel,
    "gemini-3.1-flash-lite",
    "gemini-3.8-flash",
    "gemini-flash-latest",
  ];
  const uniqueModels = [...new Set(candidateModels)];

  let lastError: any = null;
  for (const model of uniqueModels) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents: params.contents,
        config: params.config,
      });
      return res;
    } catch (err: any) {
      lastError = err;
      console.warn(`[Gemini Fallback] Model ${model} failed: ${err.message}. Retrying with next model...`);
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw lastError;
}

export async function proposeTopicsFromArticles(
  ai: GoogleGenAI,
  model: string,
  articles: Article[],
  hint?: string
): Promise<Topic[]> {
  if (!articles.length) return [];

  // 기사 목록을 한국어 번역본 기준으로 구성
  const list = articles
    .slice(0, 45)
    .map(
      (a, i) =>
        `[${i}] <${a.cat}> (${a.source})\n제목: ${a.titleKo || a.title}\n내용: ${a.snippetKo || a.snippet}`
    )
    .join("\n\n");

  const prompt = `너는 한국 2030 서브컬처(애니·게임·JPOP) 인스타그램 매거진 수석 에디터다.
아래 최신 기사 목록 중에서 카드뉴스(인스타 캐러셀)로 만들 가장 매력적인 후보 5개를 엄선하라.

[핵심 규칙 - 언어 엄수]
1. title, angle, why는 반드시 100% 매끄럽고 트렌디한 한국어로 번역/작성해야 한다.
   원문 기사가 영어이거나 일본어이더라도 무조건 한국어로 완벽히 번역하라.
2. title은 25자 이내의 클릭을 부르는 임팩트 있는 한국어 카드뉴스 헤드라인.
3. entity에는 이미지 검색용 공식 원제(영문 또는 일문, 예: "Sousou no Frieren", "Blue Archive", "YOASOBI", "Genshin Impact")를 명확히 적을 것.
4. 가능한 anime, game, jpop 분야가 골고루 포함되도록 배분할 것.
5. 공식 발표(새로운 PV, 방영/출시일 확정, 신규 캐릭터/성우 캐스팅, 대형 콜라보, 신곡/내한/투어 발표)를 최우선으로 하고 단순 루머는 배제할 것.
${hint ? `[사용자 특별 요청]: ${hint}\n` : ""}
[최신 기사 목록]
${list}

반드시 순수 JSON 배열만 출력하세요:
[
  {
    "idx": 0,
    "title": "25자 이내 한국어 헤드라인",
    "angle": "보도 각도 및 기획 포인트",
    "why": "선정 이유",
    "cat": "anime",
    "entity": "Frieren: Beyond Journey's End"
  }
]`;

  let rawList: any[] = [];
  try {
    const res = await generateContentWithFallback(ai, model, {
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      },
    });

    rawList = parseJson<
      {
        idx: number;
        title: string;
        angle: string;
        why: string;
        cat: "anime" | "game" | "jpop";
        entity: string;
      }[]
    >(res.text || "[]", []);
  } catch (err: any) {
    console.warn("[Editor Fallback] AI 선별 쿼터 제한 또는 지연 발생으로 룰 기반 추천으로 대체합니다:", err.message);
    const cats: ("anime" | "game" | "jpop")[] = ["anime", "game", "jpop", "anime", "game"];
    const chosen: number[] = [];

    cats.forEach((c) => {
      const matchIdx = articles.findIndex((a, i) => a.cat === c && !chosen.includes(i));
      if (matchIdx !== -1) chosen.push(matchIdx);
    });

    for (let i = 0; i < articles.length && chosen.length < 5; i++) {
      if (!chosen.includes(i)) chosen.push(i);
    }

    rawList = chosen.map((idx) => {
      const a = articles[idx];
      return {
        idx,
        title: (a.titleKo || a.title || "").slice(0, 30),
        angle: a.snippetKo || a.snippet || "최신 공식 발표 및 업데이트 소식",
        why: "최신 서브컬처 화제 뉴스",
        cat: a.cat,
        entity: (a.title || "").split(/[:\-–—|]/)[0].trim() || a.title,
      };
    });
  }

  // 각 후보의 title/angle이 한국어인지 검증 및 자동 보정
  const finalized: Topic[] = [];
  for (const t of rawList.slice(0, 5)) {
    const a = articles[t.idx] ?? articles[0];
    let title = t.title || a?.titleKo || a?.title || "서브컬처 최신 뉴스";
    let angle = t.angle || a?.snippetKo || a?.snippet || "";

    if (!isMostlyKorean(title) || containsJapanese(title)) {
      title = await translateSingleText(ai, title, "title");
    }
    if (angle && (!isMostlyKorean(angle) || containsJapanese(angle))) {
      angle = await translateSingleText(ai, angle, "body");
    }

    finalized.push({
      idx: t.idx,
      title,
      angle,
      why: t.why || "주요 화제 소식",
      cat: t.cat || a?.cat || "anime",
      entity: t.entity || a?.title || "",
      sourceName: a?.source,
      sourceUrl: a?.link,
      articleImages: a?.images ?? [],
    });
  }

  return finalized;
}

export async function writeContent(
  ai: GoogleGenAI,
  model: string,
  topic: Topic,
  handle: string = "@animemag.kr"
): Promise<{ slides: SlideContent[]; caption: string }> {
  // 토픽 제목과 앵글이 외국어인 경우 원고 작성 전 한국어로 선행 번역 보증
  let topicTitleKo = topic.title;
  if (!isMostlyKorean(topicTitleKo) || containsJapanese(topicTitleKo)) {
    topicTitleKo = await translateSingleText(ai, topicTitleKo, "title");
  }

  let topicAngleKo = topic.angle;
  if (topicAngleKo && (!isMostlyKorean(topicAngleKo) || containsJapanese(topicAngleKo))) {
    topicAngleKo = await translateSingleText(ai, topicAngleKo, "body");
  }

  const prompt = `너는 한국 2030 서브컬처(애니메이션·서브컬처 게임·J-POP) 전문 카드뉴스 작가다.
다음 주제에 대해 인스타그램 캐러셀 카드뉴스(4~5장)와 인스타그램 본문 캡션을 작성하라.

[주제 정보]
- 카테고리: ${topic.cat}
- 제목: ${topicTitleKo}
- 작품/대상 공식 원제: ${topic.entity}
- 기획 각도: ${topicAngleKo}
- 출처: ${topic.sourceName} (${topic.sourceUrl})

[⚠️ 핵심 필수 언어 규칙 - 100% 한국어 작성]
1. 모든 슬라이드의 headline과 body, 그리고 caption은 예외 없이 100% 유창하고 매끄러운 한국어로만 작성해야 한다.
2. 원본 기사가 영어나 일본어라도 슬라이드 텍스트에는 일본어나 영어 문장을 절대로 그대로 사용하지 말고 반드시 한국어로 완벽하게 번역 및 각색하여 작성하라. (단, 고유명사나 알파벳 브랜드명, 영문 이미지 검색어 제외)
3. 총 4~5장의 슬라이드로 구성한다:
   - 0페이지(표지): 임팩트 있는 핵심 한국어 헤드라인(10~15자 내외) + 시선을 끄는 1~2줄 인트로 훅
   - 1페이지(소식 개요): 공식 발표된 핵심 내용과 팩트 정리
   - 2페이지(세부 정보): 방영일/출시일, 성우진/제작사, 시스템 또는 음악적 특징 등 디테일
   - 3페이지(팬 반응/포인트): 팬덤의 기대 포인트, 화제 요소, 전작과의 연계 등
   - 4페이지(요약 및 일정): 주요 일정 정리 및 마무리 콜투액션
4. 각 슬라이드의 'imageQuery'에는 해당 슬라이드 내용에 어울리는 영문 이미지 검색어를 정확히 적어라.
   (예: "${topic.entity} key visual poster", "${topic.entity} anime screenshot", "${topic.entity} live concert stage")
5. 슬라이드 텍스트는 인스타그램 카드뉴스 핏으로 짧고 명료하게(문단당 2~3줄).
6. 'caption'에는 인스타그램 피드에 올라갈 감각적인 본문 글(이모지, 핵심 요약 불릿, 상세 일정, 공식 출처, 관련 해시태그 8~12개 포함)을 한국어로 작성하라.

반드시 다음 형식의 순수 JSON으로만 출력하세요:
{
  "slides": [
    {
      "headline": "100% 한국어 슬라이드 제목",
      "body": "100% 한국어 본문 텍스트 (줄바꿈 가능)",
      "imageQuery": "영문 검색어"
    }
  ],
  "caption": "인스타그램 본문 전문..."
}`;

  let parsed: { slides: SlideContent[]; caption: string };
  try {
    const res = await generateContentWithFallback(ai, model, {
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      },
    });

    parsed = parseJson<{
      slides: SlideContent[];
      caption: string;
    }>(res.text || "{}", {
      slides: [],
      caption: "",
    });

    if (!parsed.slides?.length) {
      throw new Error("Empty slides generated");
    }
  } catch (err: any) {
    console.warn("[Editor Fallback] AI 원고 작성 지연으로 한국어 템플릿 원고로 제작합니다:", err.message);
    parsed = {
      slides: [
        {
          headline: topicTitleKo,
          body: topicAngleKo || "최신 서브컬처 공식 발표 소식을 전해드립니다.\n놓치지 말아야 할 핵심 포인트를 확인하세요.",
          imageQuery: `${topic.entity} official key visual`,
        },
        {
          headline: "공식 발표 상세 내용",
          body: `${topic.entity} 관련 새로운 발표가 공개되었습니다.\n팬들의 기대를 모으고 있는 주요 정보를 정리했습니다.`,
          imageQuery: `${topic.entity} anime character screenshot`,
        },
        {
          headline: "주목해야 할 관전 포인트",
          body: "전작과의 차별점과 화제 요소, 제작진 및 출연진의 참여로 더욱 완성도 높은 콘텐츠가 기대됩니다.",
          imageQuery: `${topic.entity} official illustration`,
        },
        {
          headline: "출시 및 방영 일정 안내",
          body: "공식 채널을 통해 추가 PV 및 세부 일정이 순차적으로 공개될 예정입니다.",
          imageQuery: `${topic.entity} teaser poster`,
        },
      ],
      caption: `📰 <b>${topicTitleKo}</b>\n\n📌 <b>주요 내용</b>\n- ${topicAngleKo || topicTitleKo}\n- 공식 발표 및 세부 일정 공개\n\n📎 <b>출처:</b> ${topic.sourceName || "공식 채널"}\n🔗 <b>원문:</b> ${topic.sourceUrl || ""}\n\n매일 가장 빠른 서브컬처 뉴스는 ${handle}에서 확인하세요! ✨\n\n#${topic.cat} #서브컬처 #애니메이션 #게임소식 #JPOP #뉴스 #카드뉴스`,
    };
  }

  // 🛡️ 포토뉴스/카드뉴스 슬라이드 텍스트 100% 한국어 보증 검증 (사후 자동 번역 패치)
  for (const slide of parsed.slides) {
    if (!isMostlyKorean(slide.headline) || containsJapanese(slide.headline)) {
      slide.headline = await translateSingleText(ai, slide.headline, "slide");
    }
    if (!isMostlyKorean(slide.body) || containsJapanese(slide.body)) {
      slide.body = await translateSingleText(ai, slide.body, "slide");
    }
  }

  if (!isMostlyKorean(parsed.caption) || containsJapanese(parsed.caption)) {
    parsed.caption = await translateSingleText(ai, parsed.caption, "body");
  }

  return parsed;
}
