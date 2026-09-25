import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import dotenv from "dotenv";
import JSZip from "jszip";
import { GoogleGenAI } from "@google/genai";

import { SOURCES } from "./src/server/sources.js";
import { collectAll, markUsed } from "./src/server/collect.js";
import { pickSlideImages } from "./src/server/images.js";
import { renderSlide } from "./src/server/render.js";
import { proposeTopicsFromArticles, writeContent } from "./src/server/editor.js";
import { translateSingleText, isMostlyKorean } from "./src/server/translate.js";
import {
  sendTelegramMessage,
  sendAlbum,
  answerCallbackQuery,
  setupWebhook,
} from "./src/server/telegram.js";
import type {
  Article,
  Job,
  Topic,
  ServerConfig,
  LogEntry,
  SlideContent,
} from "./src/server/types.js";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === "production";

// Google GenAI 인스턴스 초기화
const ai = new GoogleGenAI();

// ── 서버 메모리 상태 ──

let articlesCache: Article[] = [];
let lastCollectedAt = 0;
const jobs = new Map<string, Job>();
const imageBuffers = new Map<string, Buffer>();
const seenUpdates = new Set<number>();
const logs: LogEntry[] = [];

export const config: ServerConfig = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  telegramSecret: process.env.TELEGRAM_SECRET || "subculture-mag-secret",
  publicBaseUrl: process.env.APP_URL || `http://localhost:${PORT}`,
  tgMode: (process.env.TG_MODE as any) || "off",
  cronSecret: process.env.CRON_SECRET || "subcul-cron-secret",
  handle: process.env.MAG_HANDLE || "@animemag.kr",
  braveApiKey: process.env.BRAVE_API_KEY || "",
  maxAgeHours: Number(process.env.MAX_AGE_HOURS || 48),
  textModel: process.env.TEXT_MODEL || "gemini-3.1-flash-lite",
};

export function addLog(
  level: "info" | "warn" | "error" | "success",
  message: string
) {
  const entry: LogEntry = {
    id: Math.random().toString(36).substring(2, 9),
    time: new Date().toLocaleTimeString("ko-KR", { hour12: false }),
    level,
    message,
  };
  logs.unshift(entry);
  if (logs.length > 150) logs.pop();
  console.log(`[${entry.time}] [${level.toUpperCase()}] ${message}`);
}

const newId = () => Math.random().toString(36).substring(2, 10);

// ── 핵심 파이프라인 함수 ──

async function proposeTopics(hint?: string): Promise<Job> {
  addLog("info", "토픽 제안 파이프라인 시작...");

  // 기사 캐시가 비어있거나 2시간 이상 지났으면 새로 수집
  if (!articlesCache.length || Date.now() - lastCollectedAt > 2 * 3600_000) {
    articlesCache = await collectAll(
      ai,
      config.textModel,
      config.maxAgeHours,
      (m) => addLog("info", m)
    );
    lastCollectedAt = Date.now();
  }

  const job: Job = {
    id: newId(),
    createdAt: Date.now(),
    status: "proposing",
  };
  jobs.set(job.id, job);

  try {
    const proposed = await proposeTopicsFromArticles(
      ai,
      config.textModel,
      articlesCache,
      hint
    );
    job.topics = proposed;
    job.status = "idle";
    addLog("success", `AI가 ${proposed.length}개의 카드뉴스 후보를 선별했습니다.`);

    // 텔레그램 1차 컨펌 메시지 발송 (설정되어 있는 경우)
    if (config.telegramBotToken && config.telegramChatId) {
      let text = `<b>📰 [서브컬처 매거진] 오늘의 추천 뉴스 5선</b>\n\n`;
      proposed.forEach((t, i) => {
        text += `<b>${i + 1}. [${t.cat.toUpperCase()}] ${t.title}</b>\n`;
        text += `💡 <i>${t.angle}</i>\n`;
        text += `📎 출처: ${t.sourceName || "공식 채널"}\n\n`;
      });
      text += `제작할 기사의 번호를 선택해 주세요:`;

      const keyboard = [
        proposed.map((_, i) => ({
          text: `${i + 1}번 제작`,
          callback_data: `pick:${job.id}:${i}`,
        })),
        [
          { text: "🔄 후보 다시 뽑기", callback_data: `regen:${job.id}:0` },
          { text: "❌ 취소", callback_data: `cancel:${job.id}:0` },
        ],
      ];

      await sendTelegramMessage(
        config.telegramBotToken,
        config.telegramChatId,
        text,
        { reply_markup: { inline_keyboard: keyboard } }
      );
    }

    return job;
  } catch (err: any) {
    job.status = "error";
    job.error = err.message;
    addLog("error", `토픽 제안 실패: ${err.message}`);
    throw err;
  }
}

async function buildAndPreview(
  job: Job,
  opts: { rewrite?: boolean; newImages?: boolean } = { rewrite: true, newImages: true }
): Promise<Job> {
  if (!job.topic) throw new Error("Job topic is missing");
  job.status = "generating";
  addLog("info", `🎨 "${job.topic.title}" 카드뉴스 제작을 시작합니다...`);

  try {
    // 1. 원고 작성
    if (opts.rewrite || !job.slides) {
      addLog("info", "📝 Gemini로 4~5장 슬라이드 원고 및 인스타 캡션 작성 중...");
      const written = await writeContent(
        ai,
        config.textModel,
        job.topic,
        config.handle
      );
      job.slides = written.slides;
      job.caption = written.caption;
      addLog("success", `원고 작성 완료 (슬라이드 ${job.slides.length}장)`);
    }

    // 2. 이미지 검색 & dhash 중복 방지
    if (opts.newImages || !job.slideImgs) {
      addLog("info", "🖼 기사 본문, Jikan MAL, Steam, iTunes 공식 API에서 이미지 수집 중...");
      const { bufs, urls } = await pickSlideImages(
        job.topic,
        job.slides as { imageQuery: string }[],
        job.usedImageUrls || [],
        config.braveApiKey,
        (m) => addLog("info", m)
      );
      job.slideImgs = bufs;
      job.slideImgUrls = urls;
      job.usedImageUrls = [...(job.usedImageUrls || []), ...urls];
    }

    // 3. 1080x1350 카드뉴스 렌더링
    addLog("info", "🖌 Pretendard 폰트 및 attention 크롭으로 1080x1350 슬라이드 렌더링 중...");
    const rendered = await Promise.all(
      job.slides!.map((s, i) =>
        renderSlide({
          img: job.slideImgs![i] ?? null,
          headline: s.headline,
          body: s.body,
          index: i,
          total: job.slides!.length,
          cat: job.topic!.cat,
          source: job.topic!.sourceName,
          handle: config.handle,
        })
      )
    );

    // 슬라이드 JPEG 버퍼 메모리 보관 및 Data URL 생성
    const imageFiles: string[] = [];
    const dataUrls: string[] = [];
    rendered.forEach((b, i) => {
      const fileName = `${job.id}-${i}-${Date.now()}.jpg`;
      imageBuffers.set(fileName, b);
      imageFiles.push(fileName);
      dataUrls.push(`data:image/jpeg;base64,${b.toString("base64")}`);
    });

    job.imageFiles = imageFiles;
    job.renderedSlideDataUrls = dataUrls;
    job.status = "review";
    addLog("success", `🎉 ${rendered.length}장의 카드뉴스 렌더링이 완료되었습니다!`);

    // 4. 텔레그램 2차 컨펌 (앨범 전송 + 인라인 키보드)
    if (config.telegramBotToken && config.telegramChatId) {
      addLog("info", "📱 텔레그램으로 카드뉴스 앨범 미리보기를 전송합니다...");
      await sendAlbum(
        config.telegramBotToken,
        config.telegramChatId,
        rendered,
        `📰 <b>${job.topic.title}</b>\n\n${job.caption?.slice(0, 800)}...`
      );

      await sendTelegramMessage(
        config.telegramBotToken,
        config.telegramChatId,
        `🧾 <b>2차 컨펌: 발행 여부를 선택해 주세요</b>\n\n${(job.caption || "").slice(0, 1500)}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ 인스타그램 게시 승인", callback_data: `ok:${job.id}:0` }],
              [
                { text: "🖼 다른 사진으로 교체", callback_data: `reimg:${job.id}:0` },
                { text: "✏️ 원고 다시 작성", callback_data: `rewrite:${job.id}:0` },
              ],
              [{ text: "❌ 작업 취소", callback_data: `cancel:${job.id}:0` }],
            ],
          },
        }
      );
    }

    return job;
  } catch (err: any) {
    job.status = "error";
    job.error = err.message;
    addLog("error", `카드뉴스 제작 에러: ${err.message}`);
    throw err;
  }
}

// ── 텔레그램 웹훅 및 명령 처리 ──

async function handleTelegramUpdate(u: any) {
  const from = u.message?.from?.id ?? u.callback_query?.from?.id;
  if (!from) return;

  // 인가된 사용자만 처리
  if (config.telegramChatId && String(from) !== String(config.telegramChatId)) {
    addLog("warn", `미인가 텔레그램 사용자 접근 차단: ${from}`);
    return;
  }

  // 메시지 명령어 처리
  const msgText = u.message?.text?.trim() || "";
  if (msgText.startsWith("/news") || msgText.startsWith("/start")) {
    const hint = msgText.replace(/^\/(news|start)/, "").trim();
    await sendTelegramMessage(
      config.telegramBotToken,
      from,
      `🔍 최신 서브컬처 기사를 수집하여 카드뉴스 후보를 추천합니다...`
    );
    await proposeTopics(hint || undefined);
    return;
  }

  // 콜백 쿼리 (인라인 버튼 클릭)
  const cq = u.callback_query;
  if (!cq) return;

  await answerCallbackQuery(config.telegramBotToken, cq.id, "처리 중...");

  const [act, id, arg] = (cq.data || "").split(":");
  const job = jobs.get(id);

  if (!job) {
    await sendTelegramMessage(
      config.telegramBotToken,
      from,
      "⚠️ 만료된 작업입니다. /news 로 새로운 작업을 시작해 주세요."
    );
    return;
  }

  if (job.status === "generating") {
    await sendTelegramMessage(
      config.telegramBotToken,
      from,
      "⏳ 현재 작업이 진행 중입니다. 잠시만 기다려 주세요!"
    );
    return;
  }

  switch (act) {
    case "pick": {
      const idx = Number(arg);
      job.topic = job.topics?.[idx];
      if (!job.topic) {
        await sendTelegramMessage(config.telegramBotToken, from, "선택한 토픽이 없습니다.");
        return;
      }
      await sendTelegramMessage(
        config.telegramBotToken,
        from,
        `🎨 <b>선택: ${job.topic.title}</b>\n카드뉴스 제작을 시작합니다.`
      );
      await buildAndPreview(job);
      break;
    }
    case "regen": {
      await proposeTopics();
      break;
    }
    case "reimg": {
      await sendTelegramMessage(config.telegramBotToken, from, "🖼 다른 사진을 탐색하여 슬라이드를 다시 제작합니다...");
      await buildAndPreview(job, { rewrite: false, newImages: true });
      break;
    }
    case "rewrite": {
      await sendTelegramMessage(config.telegramBotToken, from, "✏️ 원고를 새로운 각도로 재작성합니다...");
      await buildAndPreview(job, { rewrite: true, newImages: false });
      break;
    }
    case "ok": {
      job.status = "published";
      if (job.topic?.sourceUrl) markUsed(job.topic.sourceUrl);
      addLog("success", `[승인 완료] "${job.topic?.title}" 발행 처리되었습니다.`);
      await sendTelegramMessage(
        config.telegramBotToken,
        from,
        `🎉 <b>발행 승인 완료!</b>\n고품질 1080x1350 카드뉴스가 준비되었습니다.`
      );
      break;
    }
    case "cancel": {
      job.status = "canceled";
      addLog("info", `[작업 취소] "${job.topic?.title || job.id}"`);
      await sendTelegramMessage(config.telegramBotToken, from, "❌ 작업을 취소했습니다.");
      break;
    }
  }
}

// ── REST API 라우트 ──

app.get("/api/config", (_req, res) => {
  res.json({
    ...config,
    telegramBotTokenMasked: config.telegramBotToken
      ? `${config.telegramBotToken.slice(0, 6)}...${config.telegramBotToken.slice(-4)}`
      : "",
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    hasBraveKey: Boolean(config.braveApiKey),
  });
});

app.post("/api/telegram/test-connection", async (req, res) => {
  const token = req.body.telegramBotToken || config.telegramBotToken;
  const chatId = req.body.telegramChatId || config.telegramChatId;

  if (!token || !chatId) {
    return res.status(400).json({
      ok: false,
      error: "텔레그램 봇 토큰(API 키)과 Chat ID를 모두 입력해 주세요.",
    });
  }

  try {
    const text = `🎉 <b>[서브컬처 매거진 봇] 연동 테스트 성공!</b>\n\n봇 API 키와 Chat ID가 정상적으로 연결되었습니다.\n이제부터 최신 애니·게임·J-POP 카드뉴스와 추천 토픽을 텔레그램에서 바로 확인하실 수 있습니다. ✨\n\n⏱ 테스트 시각: ${new Date().toLocaleTimeString("ko-KR")}`;
    const result = await sendTelegramMessage(token, chatId, text);

    if (result?.ok) {
      config.telegramBotToken = token;
      config.telegramChatId = chatId;
      addLog("success", `텔레그램 테스트 메시지 전송 성공 (Chat ID: ${chatId})`);
      return res.json({ ok: true });
    } else {
      addLog("error", `텔레그램 전송 실패: ${result?.description || JSON.stringify(result)}`);
      return res.status(400).json({
        ok: false,
        error: result?.description || "텔레그램 봇 응답 오류. 토큰과 Chat ID를 다시 확인해 주세요.",
      });
    }
  } catch (err: any) {
    addLog("error", `텔레그램 연동 오류: ${err.message}`);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/config", (req, res) => {
  const {
    telegramBotToken,
    telegramChatId,
    telegramSecret,
    publicBaseUrl,
    handle,
    braveApiKey,
    maxAgeHours,
    textModel,
  } = req.body;

  if (telegramBotToken !== undefined) config.telegramBotToken = telegramBotToken;
  if (telegramChatId !== undefined) config.telegramChatId = telegramChatId;
  if (telegramSecret !== undefined) config.telegramSecret = telegramSecret;
  if (publicBaseUrl !== undefined) config.publicBaseUrl = publicBaseUrl;
  if (handle !== undefined) config.handle = handle;
  if (braveApiKey !== undefined) config.braveApiKey = braveApiKey;
  if (maxAgeHours !== undefined) config.maxAgeHours = Number(maxAgeHours);
  if (textModel !== undefined) config.textModel = textModel;

  addLog("info", "서버 설정이 업데이트되었습니다.");
  res.json({ ok: true, config });
});

app.get("/api/sources", (_req, res) => {
  res.json({
    sources: SOURCES,
    total: SOURCES.length,
    cachedArticlesCount: articlesCache.length,
    lastCollectedAt,
  });
});

app.post("/api/collect", async (_req, res) => {
  try {
    articlesCache = await collectAll(
      ai,
      config.textModel,
      config.maxAgeHours,
      (m) => addLog("info", m)
    );
    lastCollectedAt = Date.now();
    res.json({
      ok: true,
      count: articlesCache.length,
      articles: articlesCache,
    });
  } catch (err: any) {
    addLog("error", `수집 실패: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/articles", (req, res) => {
  const cat = req.query.cat as string;
  let list = articlesCache;
  if (cat && ["anime", "game", "jpop"].includes(cat)) {
    list = list.filter((a) => a.cat === cat);
  }
  res.json({
    articles: list,
    lastCollectedAt,
    total: articlesCache.length,
  });
});

app.post("/api/propose", async (req, res) => {
  const { hint } = req.body;
  try {
    const job = await proposeTopics(hint);
    res.json({ ok: true, job });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/translate-article", async (req, res) => {
  const { link, title, snippet } = req.body;
  if (!title) return res.status(400).json({ ok: false, error: "Title is required" });

  try {
    const titleKo = await translateSingleText(ai, title, "title");
    let snippetKo = snippet;
    if (snippet && !isMostlyKorean(snippet)) {
      snippetKo = await translateSingleText(ai, snippet, "body");
    }

    if (link) {
      const art = articlesCache.find((a) => a.link === link);
      if (art) {
        art.titleKo = titleKo;
        art.snippetKo = snippetKo;
      }
    }

    res.json({ ok: true, titleKo, snippetKo });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/generate", async (req, res) => {
  const { topic, custom } = req.body;
  try {
    let targetTopic: Topic;

    if (custom) {
      targetTopic = {
        idx: -1,
        title: custom.title || "서브컬처 특별 기획",
        angle: custom.angle || "긴급 속보 및 주요 내용 정리",
        why: "사용자 직접 기획 제작",
        cat: custom.cat || "anime",
        entity: custom.entity || custom.title || "Anime",
        sourceName: custom.sourceName || "공식 발표",
        sourceUrl: custom.sourceUrl || "",
        articleImages: custom.imageUrl ? [custom.imageUrl] : [],
      };
    } else if (topic) {
      targetTopic = topic;
    } else {
      return res.status(400).json({ ok: false, error: "topic 또는 custom 입력이 필요합니다." });
    }

    // 🛡️ 카드뉴스 제작 전 토픽 제목/앵글 100% 한국어 검증
    if (!isMostlyKorean(targetTopic.title)) {
      targetTopic.title = await translateSingleText(ai, targetTopic.title, "title");
    }
    if (targetTopic.angle && !isMostlyKorean(targetTopic.angle)) {
      targetTopic.angle = await translateSingleText(ai, targetTopic.angle, "body");
    }

    const job: Job = {
      id: newId(),
      createdAt: Date.now(),
      status: "generating",
      topic: targetTopic,
    };
    jobs.set(job.id, job);

    // 백그라운드 대신 결과를 대기하여 브라우저에 반환
    const completedJob = await buildAndPreview(job);
    res.json({ ok: true, job: completedJob });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/jobs", (_req, res) => {
  const list = [...jobs.values()]
    .map((j) => ({
      id: j.id,
      createdAt: j.createdAt,
      status: j.status,
      title: j.topic?.title || "미정",
      cat: j.topic?.cat || "anime",
      slideCount: j.slides?.length || 0,
      hasImages: Boolean(j.renderedSlideDataUrls?.length),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ jobs: list });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });
  res.json({ ok: true, job });
});

app.get("/api/jobs/:id/slides/:index.jpg", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.imageFiles) return res.status(404).send("Not found");
  const idx = Number(req.params.index);
  const fileName = job.imageFiles[idx];
  if (!fileName || !imageBuffers.has(fileName)) return res.status(404).send("Slide not found");

  const buf = imageBuffers.get(fileName)!;
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(buf);
});

app.get("/api/jobs/:id/download-zip", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.imageFiles?.length) return res.status(404).send("Job images not found");

  try {
    const zip = new JSZip();
    job.imageFiles.forEach((f, i) => {
      const b = imageBuffers.get(f);
      if (b) {
        zip.file(`slide_${String(i + 1).padStart(2, "0")}.jpg`, b);
      }
    });

    if (job.caption) {
      zip.file("instagram_caption.txt", job.caption);
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const cleanTitle = (job.topic?.title || "magazine")
      .replace(/[^\w\s\uAC00-\uD7A3-]/g, "")
      .trim()
      .slice(0, 30);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(cleanTitle || "magazine")}_cards.zip"`
    );
    res.send(zipBuffer);
  } catch (err: any) {
    res.status(500).send("Zip generation error");
  }
});

app.post("/api/jobs/:id/regenerate-images", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });
  try {
    const updated = await buildAndPreview(job, { rewrite: false, newImages: true });
    res.json({ ok: true, job: updated });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/jobs/:id/rewrite", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });
  try {
    const updated = await buildAndPreview(job, { rewrite: true, newImages: false });
    res.json({ ok: true, job: updated });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/jobs/:id/update-slide", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.slides) return res.status(404).json({ ok: false, error: "Job not found" });
  const { index, headline, body } = req.body;
  if (index === undefined || !job.slides[index]) {
    return res.status(400).json({ ok: false, error: "Invalid slide index" });
  }

  job.slides[index].headline = headline ?? job.slides[index].headline;
  job.slides[index].body = body ?? job.slides[index].body;

  // 해당 슬라이드 재렌더링
  try {
    const newBuf = await renderSlide({
      img: job.slideImgs?.[index] ?? null,
      headline: job.slides[index].headline,
      body: job.slides[index].body,
      index,
      total: job.slides.length,
      cat: job.topic!.cat,
      source: job.topic!.sourceName,
      handle: config.handle,
    });

    const fileName = `${job.id}-${index}-${Date.now()}.jpg`;
    imageBuffers.set(fileName, newBuf);
    job.imageFiles![index] = fileName;
    job.renderedSlideDataUrls![index] = `data:image/jpeg;base64,${newBuf.toString("base64")}`;

    addLog("info", `슬라이드 #${index + 1} 텍스트 수정 및 재렌더링 완료`);
    res.json({ ok: true, job });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/jobs/:id/send-telegram", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });
  if (!config.telegramBotToken || !config.telegramChatId) {
    return res.status(400).json({ ok: false, error: "Telegram bot token or Chat ID is missing" });
  }

  try {
    const buffers = (job.imageFiles || [])
      .map((f) => imageBuffers.get(f))
      .filter(Boolean) as Buffer[];

    if (!buffers.length) {
      return res.status(400).json({ ok: false, error: "렌더링된 슬라이드 이미지가 없습니다." });
    }

    await sendAlbum(
      config.telegramBotToken,
      config.telegramChatId,
      buffers,
      `📰 <b>${job.topic?.title || "서브컬처 매거진"}</b>\n\n${job.caption?.slice(0, 900)}`
    );

    addLog("success", `텔레그램으로 카드뉴스 앨범 전송 완료`);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/logs", (_req, res) => {
  res.json({ logs });
});

// ── 텔레그램 공식 웹훅 라우트 ──

app.post("/tg/webhook", async (req, res) => {
  if (
    config.telegramSecret &&
    req.get("X-Telegram-Bot-Api-Secret-Token") !== config.telegramSecret
  ) {
    return res.sendStatus(401);
  }

  const id = req.body?.update_id;
  if (id && seenUpdates.has(id)) {
    return res.sendStatus(200);
  }
  if (id) seenUpdates.add(id);

  handleTelegramUpdate(req.body).catch((e) => addLog("error", `Webhook error: ${e.message}`));
  res.sendStatus(200);
});

app.get("/tg/setup", async (_req, res) => {
  if (!config.telegramBotToken) {
    return res.status(400).json({ ok: false, error: "텔레그램 봇 토큰이 설정되지 않았습니다." });
  }
  const result = await setupWebhook(
    config.telegramBotToken,
    config.publicBaseUrl,
    config.telegramSecret
  );
  addLog("info", `텔레그램 웹훅 등록 시도: ${JSON.stringify(result)}`);
  res.json(result);
});

// ── Cloud Scheduler Cron 라우트 ──

app.get("/cron", async (req, res) => {
  if (req.query.key !== config.cronSecret) {
    return res.status(401).json({ error: "Unauthorized cron trigger" });
  }
  addLog("info", "⏰ Cloud Scheduler 크론 트리거 실행");
  try {
    await proposeTopics();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Vite 미들웨어 및 서버 시작 ──

async function startServer() {
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve("dist")));
    app.get("*", (_req, res) => {
      res.sendFile(path.resolve("dist/index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    addLog("success", `서브컬처 매거진 봇 서버가 포트 ${PORT}에서 준비되었습니다.`);
    console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
});
