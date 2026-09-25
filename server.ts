import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import dotenv from "dotenv";
import JSZip from "jszip";
import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";

import { SOURCES } from "./src/server/sources.js";
import { collectAll, markUsed } from "./src/server/collect.js";
import { pickSlideImages, downloadImage } from "./src/server/images.js";
import { renderSlide } from "./src/server/render.js";
import { proposeTopicsFromArticles, writeContent } from "./src/server/editor.js";
import { translateSingleText, isMostlyKorean } from "./src/server/translate.js";
import {
  sendTelegramMessage,
  sendAlbum,
  answerCallbackQuery,
  setupWebhook,
  sendPhoto,
  editPhoto,
  sendVideo,
  downloadTelegramFile,
} from "./src/server/telegram.js";
import { publishCarousel, publishReel } from "./src/server/instagram.js";
import { makeSlideshowReel } from "./src/server/video.js";
import type {
  Article,
  Job,
  Topic,
  ServerConfig,
  LogEntry,
  SlideContent,
  Pending,
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
  igUserId: process.env.IG_USER_ID || "",
  igAccessToken: process.env.IG_ACCESS_TOKEN || "",
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
    const balanced = (["anime", "game", "jpop"] as const)
      .flatMap((c) => articlesCache.filter((a) => a.cat === c).slice(0, 15));
    const cnt = (c: string) => balanced.filter((a) => a.cat === c).length;
    addLog(
      cnt("jpop") ? "info" : "warn",
      `후보 풀: 애니 ${cnt("anime")} · 게임 ${cnt("game")} · J-POP ${cnt("jpop")}`
    );
    const proposed = await proposeTopicsFromArticles(
      ai,
      config.textModel,
      balanced,
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
          { text: "🎌 애니만", callback_data: `regen:${job.id}:anime` },
          { text: "🎮 게임만", callback_data: `regen:${job.id}:game` },
          { text: "🎵 J-POP만", callback_data: `regen:${job.id}:jpop` },
        ],
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

// ── 텔레그램 편집 흐름 헬퍼 ──

const esc = (s = "") =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const plain = (s = "") => s.replace(/<[^>]+>/g, "");
type Btn = [string, string];
const ik = (rows: Btn[][]) => ({
  inline_keyboard: rows.map((r) =>
    r.map(([text, callback_data]) => ({ text, callback_data }))
  ),
});
const say = (text: string, rows?: Btn[][]) =>
  sendTelegramMessage(
    config.telegramBotToken,
    config.telegramChatId,
    text,
    rows ? { reply_markup: ik(rows) } : {}
  );
const clamp = (v: number, a = 0, b = 100) => Math.max(a, Math.min(b, v));

let pendingJobId: string | null = null;
function setPending(job: Job, p: Pending) {
  job.pending = p;
  pendingJobId = job.id;
}

function storeMedia(buf: Buffer, ext: "jpg" | "mp4") {
  const name = `${newId()}${newId()}.${ext}`;
  imageBuffers.set(name, buf);
  return name;
}
const mediaUrl = (name: string) =>
  `${config.publicBaseUrl.replace(/\/+$/, "")}/media/${name}`;
const slideBufs = (job: Job) =>
  (job.imageFiles || []).map((f) => imageBuffers.get(f)!).filter(Boolean);

async function renderOne(job: Job, i: number) {
  const s = job.slides![i];
  const buf = await renderSlide({
    img: job.slideImgs?.[i] ?? null,
    headline: s.headline,
    body: s.body,
    index: i,
    total: job.slides!.length,
    cat: job.topic!.cat,
    source: job.topic!.sourceName,
    handle: config.handle,
    style: { ...(s.style || {}), aspectRatio: job.cardRatio || "4:5" },
  });
  job.imageFiles ??= [];
  job.renderedSlideDataUrls ??= [];
  const old = job.imageFiles[i];
  if (old) imageBuffers.delete(old);
  job.imageFiles[i] = storeMedia(buf, "jpg");
  job.renderedSlideDataUrls[i] = `data:image/jpeg;base64,${buf.toString("base64")}`;
  return buf;
}

async function renderAll(job: Job) {
  (job.imageFiles || []).forEach((f) => imageBuffers.delete(f));
  job.imageFiles = [];
  job.renderedSlideDataUrls = [];
  return Promise.all(job.slides!.map((_, i) => renderOne(job, i)));
}

// 슬라이드 관련 배열들을 한꺼번에 조작 (페이지 삭제/이동용)
function slideArrays(job: Job): any[][] {
  job.slideCandidates ??= [];
  job.candidateCursor ??= [];
  return [
    job.slides!,
    job.slideImgs!,
    job.slideImgUrls!,
    job.slideCandidates,
    job.candidateCursor,
  ];
}

async function nextImage(job: Job, i: number): Promise<boolean> {
  const own = job.slideCandidates?.[i] || [];
  const cands = own.length ? own : (job.slideCandidates || []).flat();
  job.candidateCursor ??= [];
  for (let c = job.candidateCursor[i] ?? 0; c < cands.length; c++) {
    const u = cands[c];
    if (!u || job.slideImgUrls?.includes(u)) continue;
    const b = await downloadImage(u);
    if (!b) continue;
    job.slideImgs![i] = b;
    job.slideImgUrls![i] = u;
    job.candidateCursor[i] = c + 1;
    delete job.slides![i].style;
    return true;
  }
  job.candidateCursor[i] = 0;
  return false;
}

function slideCaption(job: Job, i: number) {
  const st = job.slides![i].style || {};
  return (
    `🛠 <b>${i + 1}/${job.slides!.length}페이지 편집</b>\n${esc(job.slides![i].headline)}\n\n` +
    `크기 x${(st.imageScale ?? 1).toFixed(2)} · 위치 X${st.imageOffsetX ?? 50}/Y${st.imageOffsetY ?? 50} · ` +
    `사진영역 ${Math.round((st.imageRatio ?? 1) * 100)}% · ${st.imageFit ?? "cover"}`
  );
}

function slideKb(job: Job, i: number) {
  const id = job.id;
  return ik([
    [
      ["⬆️ 위쪽", `mv:${id}:${i}:u`],
      ["⬇️ 아래쪽", `mv:${id}:${i}:d`],
      ["⬅️", `mv:${id}:${i}:l`],
      ["➡️", `mv:${id}:${i}:r`],
    ],
    [
      ["🔍 확대", `mv:${id}:${i}:zi`],
      ["🔎 축소", `mv:${id}:${i}:zo`],
      ["⛶ 맞춤 전환", `mv:${id}:${i}:fit`],
    ],
    [
      ["사진영역 100%", `mv:${id}:${i}:r100`],
      ["60%", `mv:${id}:${i}:r60`],
      ["45%", `mv:${id}:${i}:r45`],
    ],
    [
      ["🔄 다음 후보 사진", `nimg:${id}:${i}`],
      ["📤 내 사진으로 교체", `upimg:${id}:${i}`],
    ],
    [
      ["✏️ 텍스트 수정", `txt:${id}:${i}`],
      ["➕ 뒤에 페이지 추가", `add:${id}:${i}`],
    ],
    [
      ["◀ 앞으로 이동", `mvp:${id}:${i}`],
      ["🗑 삭제", `del:${id}:${i}`],
      ["↩️ 목록", `menu:${id}`],
    ],
  ]);
}

function applyMove(job: Job, i: number, op: string) {
  const st = (job.slides![i].style ??= {});
  const step = 12;
  if (op === "u") st.imageOffsetY = clamp((st.imageOffsetY ?? 50) - step);
  if (op === "d") st.imageOffsetY = clamp((st.imageOffsetY ?? 50) + step);
  if (op === "l") st.imageOffsetX = clamp((st.imageOffsetX ?? 50) - step);
  if (op === "r") st.imageOffsetX = clamp((st.imageOffsetX ?? 50) + step);
  if (op === "zi") st.imageScale = Math.min(2.5, (st.imageScale ?? 1) + 0.15);
  if (op === "zo") st.imageScale = Math.max(1, (st.imageScale ?? 1) - 0.15);
  if (op === "fit") st.imageFit = st.imageFit === "contain" ? "cover" : "contain";
  if (op === "r100") st.imageRatio = 1;
  if (op === "r60") st.imageRatio = 0.6;
  if (op === "r45") st.imageRatio = 0.45;
}

async function sendSlideEditor(job: Job, i: number) {
  const buf = imageBuffers.get(job.imageFiles![i]) || (await renderOne(job, i));
  await sendPhoto(
    config.telegramBotToken,
    config.telegramChatId,
    buf,
    slideCaption(job, i),
    slideKb(job, i)
  );
}

// 2단계: 컨펌·편집 메뉴
async function sendEditMenu(job: Job, withAlbum = true) {
  const id = job.id,
    n = job.slides!.length;
  if (withAlbum) {
    await sendAlbum(
      config.telegramBotToken,
      config.telegramChatId,
      slideBufs(job),
      `📰 ${plain(job.topic!.title)} 미리보기 (${n}장)`
    );
  }
  const pages: Btn[] = job.slides!.map((_, i) => [`${i + 1}p 편집`, `sl:${id}:${i}`]);
  const rows: Btn[][] = [];
  for (let k = 0; k < pages.length; k += 4) rows.push(pages.slice(k, k + 4));
  rows.push([
    ["➕ 맨 뒤에 페이지 추가", `add:${id}:${n - 1}`],
    [`📐 비율 ${job.cardRatio || "4:5"} → 전환`, `ratio:${id}`],
  ]);
  rows.push([
    ["✏️ 캡션 수정", `cap:${id}`],
    ["🖼 사진 전체 다시", `reimg:${id}`],
    ["📝 원고 재작성", `rewrite:${id}`],
  ]);
  rows.push([["✅ 컨펌 완료 → 음악 선택", `next:${id}`]]);
  rows.push([["❌ 작업 취소", `cancel:${id}`]]);
  await say(
    `🧾 <b>2단계: 카드뉴스 컨펌</b>\n수정할 페이지를 누르세요.\n\n<b>캡션 미리보기</b>\n${esc(
      plain(job.caption || "")
    ).slice(0, 700)}`,
    rows
  );
}

async function publishJob(job: Job, mode: "c" | "r") {
  if (!config.igUserId || !config.igAccessToken) {
    await say("⚠️ IG_USER_ID / IG_ACCESS_TOKEN 환경변수를 먼저 설정해 주세요.");
    return;
  }
  if (/localhost|aistudio\.google\.com/.test(config.publicBaseUrl)) {
    await say(
      "⚠️ APP_URL 이 공개 주소가 아닙니다. 인스타 서버가 이미지를 가져갈 수 있는 배포(Cloud Run) 주소가 필요합니다."
    );
    return;
  }
  job.status = "generating";
  await say("📤 인스타그램 업로드 중... (1~3분)");
  try {
    const caption = plain(job.caption || "").slice(0, 2200);
    const r =
      mode === "r"
        ? await publishReel({
            igUserId: config.igUserId,
            token: config.igAccessToken,
            videoUrl: mediaUrl(job.videoFile!),
            caption,
            audioName: job.music?.name,
          })
        : await publishCarousel({
            igUserId: config.igUserId,
            token: config.igAccessToken,
            imageUrls: job.imageFiles!.slice(0, 10).map(mediaUrl),
            caption,
          });
    job.status = "published";
    if (job.topic?.sourceUrl) markUsed(job.topic.sourceUrl);
    addLog("success", `인스타 업로드 완료: ${r.permalink || r.id}`);
    await say(`🎉 <b>업로드 완료!</b>\n${r.permalink || r.id}`);
  } catch (e: any) {
    job.status = "review";
    addLog("error", `인스타 업로드 실패: ${e.message}`);
    await say(`❌ 업로드 실패: ${esc(e.message)}`, [
      [
        ["🔁 다시 시도", `go:${job.id}:${mode}`],
        ["↩️ 편집으로", `menu:${job.id}`],
      ],
    ]);
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
      const { bufs, urls, cands } = await pickSlideImages(
        job.topic,
        job.slides as { imageQuery: string }[],
        job.usedImageUrls || [],
        config.braveApiKey,
        (m) => addLog("info", m)
      );
      job.slideImgs = bufs;
      job.slideImgUrls = urls;
      job.slideCandidates = cands;
      job.candidateCursor = [];
      job.usedImageUrls = [...(job.usedImageUrls || []), ...urls.filter(Boolean)];
      job.slides!.forEach((s) => delete s.style);
    }

    await renderAll(job);
    job.status = "review";
    addLog("success", `🎉 ${job.slides!.length}장 렌더링 완료`);
    if (config.telegramBotToken && config.telegramChatId) await sendEditMenu(job);
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
  if (config.telegramChatId && String(from) !== String(config.telegramChatId)) {
    addLog("warn", `미인가 텔레그램 사용자 차단: ${from}`);
    return;
  }

  // ── 일반 메시지 (명령어 / 사진·텍스트·음악 입력) ──
  const msg = u.message;
  if (msg) {
    const text = (msg.text || msg.caption || "").trim();
    if (/^\/(news|start)/.test(text)) {
      await say("🔍 최신 서브컬처 기사를 수집해서 후보를 추천합니다...");
      await proposeTopics(text.replace(/^\/(news|start)/, "").trim() || undefined);
      return;
    }
    const job = pendingJobId ? jobs.get(pendingJobId) : undefined;
    if (text === "/cancel" && job) {
      job.pending = undefined;
      await say("입력을 취소했습니다.");
      await sendEditMenu(job, false);
      return;
    }
    if (job?.pending) await handlePending(job, msg, text);
    return;
  }

  // ── 버튼 클릭 ──
  const cq = u.callback_query;
  if (!cq) return;
  await answerCallbackQuery(config.telegramBotToken, cq.id, "처리 중...");
  const [act, id, a1, a2] = (cq.data || "").split(":");
  const job = jobs.get(id);
  const msgId: number | undefined = cq.message?.message_id;
  if (!job) {
    await say("⚠️ 만료된 작업입니다. /news 로 새로 시작해 주세요.");
    return;
  }
  if (job.status === "generating") {
    await say("⏳ 작업이 진행 중입니다. 잠시만 기다려 주세요!");
    return;
  }
  const i = Number(a1);

  switch (act) {
    // 1단계
    case "pick": {
      job.topic = job.topics?.[i];
      if (!job.topic) {
        await say("선택한 토픽이 없습니다.");
        return;
      }
      await say(`🎨 <b>선택: ${esc(job.topic.title)}</b>\n카드뉴스 제작을 시작합니다.`);
      await buildAndPreview(job);
      break;
    }
    case "regen": {
      const hints: Record<string, string> = {
        anime: "애니메이션 소식만",
        game: "서브컬처 게임 소식만",
        jpop: "J-POP·애니송 소식만",
      };
      await proposeTopics(hints[a1]);
      break;
    }

    // 2단계: 편집
    case "menu":
      job.pending = undefined;
      await sendEditMenu(job, true);
      break;
    case "sl":
      await sendSlideEditor(job, i);
      break;
    case "mv": {
      applyMove(job, i, a2);
      const buf = await renderOne(job, i);
      if (msgId)
        await editPhoto(
          config.telegramBotToken,
          config.telegramChatId,
          msgId,
          buf,
          slideCaption(job, i),
          slideKb(job, i)
        );
      break;
    }
    case "nimg": {
      if (!(await nextImage(job, i))) {
        await say("더 이상 후보 사진이 없습니다. 📤 <b>내 사진으로 교체</b>를 이용해 주세요.");
        return;
      }
      const buf = await renderOne(job, i);
      if (msgId)
        await editPhoto(
          config.telegramBotToken,
          config.telegramChatId,
          msgId,
          buf,
          slideCaption(job, i),
          slideKb(job, i)
        );
      break;
    }
    case "upimg":
      setPending(job, { kind: "photo", slideIdx: i });
      await say(`📤 ${i + 1}페이지에 넣을 <b>사진</b>(또는 이미지 URL)을 보내 주세요. 취소: /cancel`);
      break;
    case "txt": {
      const s = job.slides![i];
      setPending(job, { kind: "editText", slideIdx: i });
      await say(
        `✏️ 현재 내용:\n<code>${esc(s.headline)}\n${esc(s.body)}</code>\n\n첫 줄은 제목, 둘째 줄부터는 본문으로 보내 주세요.`
      );
      break;
    }
    case "add":
      setPending(job, { kind: "addPage", afterIdx: i });
      await say(
        `➕ ${i + 2}페이지로 들어갈 내용을 보내 주세요.\n첫 줄은 제목, 다음 줄부터 본문입니다.\n사진에 캡션으로 적어 보내면 그 사진이 사용됩니다.`
      );
      break;
    case "del": {
      if (job.slides!.length <= 2) {
        await say("최소 2장은 있어야 합니다.");
        return;
      }
      slideArrays(job).forEach((arr) => arr.splice(i, 1));
      await renderAll(job);
      await say(`🗑 ${i + 1}페이지를 삭제했습니다.`);
      await sendEditMenu(job);
      break;
    }
    case "mvp": {
      if (i <= 0) return;
      slideArrays(job).forEach((arr) => {
        [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
      });
      await renderAll(job);
      await sendEditMenu(job);
      break;
    }
    case "ratio":
      // 인스타 캐러셀은 첫 장 비율로 전체가 잘리므로 전체 통일 (피드는 4:5 / 1:1 권장)
      job.cardRatio = job.cardRatio === "1:1" ? "4:5" : "1:1";
      await renderAll(job);
      await sendEditMenu(job);
      break;
    case "cap":
      setPending(job, { kind: "caption" });
      await say("✏️ 새 인스타 캡션 전체를 보내 주세요. 취소: /cancel");
      break;
    case "reimg":
      await say("🖼 새 사진을 찾아서 다시 만듭니다...");
      await buildAndPreview(job, { rewrite: false, newImages: true });
      break;
    case "rewrite":
      await say("✏️ 원고를 다시 작성합니다...");
      await buildAndPreview(job, { rewrite: true, newImages: false });
      break;

    // 3단계: 음악 선택 후 업로드
    case "next":
      await say(
        "🎵 <b>3단계: 음악 선택</b>\n인스타 API는 이미지 캐러셀에 음악을 붙일 수 없습니다.\n음악을 넣으면 슬라이드 영상(<b>릴스</b>)으로 만들어 올립니다.",
        [
          [["🎵 음악 넣기 (릴스로 게시)", `music:${id}`]],
          [["🖼 음악 없이 캐러셀 게시", `pubc:${id}`]],
          [["↩️ 편집으로", `menu:${id}`]],
        ]
      );
      break;
    case "music":
      setPending(job, { kind: "music" });
      await say(
        "🎵 음악 파일(mp3/m4a, 20MB 이하)을 보내 주세요.\n파일 캡션에 시작 초(예: <code>45</code>)를 적으면 그 지점부터 사용합니다.\n⚠️ 상업 음원은 저작권 때문에 음소거되거나 삭제될 수 있습니다."
      );
      break;
    case "pubc":
      await say(
        `✅ <b>최종 확인</b>\n${job.slides!.length}장 캐러셀을 인스타그램에 게시할까요?`,
        [
          [["🚀 업로드 확정", `go:${id}:c`]],
          [["↩️ 편집으로", `menu:${id}`]],
        ]
      );
      break;
    case "go":
      await publishJob(job, a1 === "r" ? "r" : "c");
      break;
    case "cancel":
      job.status = "canceled";
      job.pending = undefined;
      await say("❌ 작업을 취소했습니다.");
      break;
  }
}

async function handlePending(job: Job, msg: any, text: string) {
  const token = config.telegramBotToken;
  const p = job.pending!;
  const photoId =
    msg.photo?.at(-1)?.file_id ||
    (msg.document?.mime_type?.startsWith("image/") ? msg.document.file_id : undefined);
  const audioId =
    msg.audio?.file_id ||
    msg.voice?.file_id ||
    (msg.document?.mime_type?.startsWith("audio/") ? msg.document.file_id : undefined);
  const split = (t: string) => {
    const [h, ...rest] = t.split("\n");
    return { headline: h.trim(), body: rest.join(" ").trim() };
  };
  const loadPhoto = async () => {
    const raw = photoId
      ? await downloadTelegramFile(token, photoId)
      : /^https?:\/\//.test(text)
      ? await downloadImage(text)
      : null;
    return raw ? await sharp(raw).rotate().jpeg({ quality: 92 }).toBuffer() : null; // 폰 사진 회전 정보 보정
  };

  switch (p.kind) {
    case "photo": {
      const buf = await loadPhoto();
      if (!buf) {
        await say("사진이나 이미지 URL을 보내 주세요. 취소: /cancel");
        return;
      }
      job.slideImgs![p.slideIdx] = buf;
      job.slideImgUrls![p.slideIdx] = "user-upload";
      delete job.slides![p.slideIdx].style;
      job.pending = undefined;
      await renderOne(job, p.slideIdx);
      await sendSlideEditor(job, p.slideIdx);
      return;
    }
    case "editText": {
      if (!text) {
        await say("텍스트로 보내 주세요.");
        return;
      }
      const { headline, body } = split(text);
      job.slides![p.slideIdx].headline = headline;
      if (body) job.slides![p.slideIdx].body = body;
      job.pending = undefined;
      await renderOne(job, p.slideIdx);
      await sendSlideEditor(job, p.slideIdx);
      return;
    }
    case "addPage": {
      if (!text) {
        await say("첫 줄 제목, 다음 줄 본문으로 보내 주세요. (사진 캡션도 가능)");
        return;
      }
      const { headline, body } = split(text);
      const at = p.afterIdx + 1;
      const img = await loadPhoto();
      slideArrays(job); // 배열 초기화
      job.slides!.splice(at, 0, { headline, body, imageQuery: "" });
      job.slideImgs!.splice(at, 0, img);
      job.slideImgUrls!.splice(at, 0, img ? "user-upload" : "");
      job.slideCandidates!.splice(at, 0, []);
      job.candidateCursor!.splice(at, 0, 0);
      if (!img) await nextImage(job, at);
      job.pending = undefined;
      await renderAll(job);
      await say(`➕ ${at + 1}페이지를 추가했습니다.`);
      await sendEditMenu(job);
      return;
    }
    case "caption": {
      if (!text) {
        await say("캡션을 텍스트로 보내 주세요.");
        return;
      }
      job.caption = text;
      job.pending = undefined;
      await say("✅ 캡션을 수정했습니다.");
      await sendEditMenu(job, false);
      return;
    }
    case "music": {
      if (!audioId) {
        await say("🎵 음악 파일을 보내 주세요. 취소: /cancel");
        return;
      }
      const size =
        msg.audio?.file_size || msg.voice?.file_size || msg.document?.file_size || 0;
      if (size > 20 * 1024 * 1024) {
        await say("20MB 이하 파일만 받을 수 있습니다.");
        return;
      }
      const start = Number((msg.caption || "").match(/\d+(\.\d+)?/)?.[0] || 0);
      const name = msg.audio
        ? [msg.audio.performer, msg.audio.title].filter(Boolean).join(" - ") || "BGM"
        : msg.document?.file_name || "BGM";
      job.pending = undefined;
      job.status = "generating";
      try {
        await say("🎬 슬라이드와 음악으로 릴스 영상을 만드는 중...");
        const audio = await downloadTelegramFile(token, audioId);
        const video = await makeSlideshowReel(slideBufs(job), audio, { audioStart: start });
        if (job.videoFile) imageBuffers.delete(job.videoFile);
        job.videoFile = storeMedia(video, "mp4");
        job.music = { name, start };
        await sendVideo(
          token,
          config.telegramChatId,
          video,
          `🎬 릴스 미리보기\n🎵 ${esc(name)} (${start}초부터)`,
          ik([
            [["🚀 인스타 릴스 업로드", `go:${job.id}:r`]],
            [
              ["🔁 다른 음악", `music:${job.id}`],
              ["↩️ 편집으로", `menu:${job.id}`],
            ],
          ])
        );
      } catch (e: any) {
        await say(`❌ 영상 제작 실패: ${esc(e.message).slice(0, 500)}`);
      } finally {
        job.status = "review";
      }
      return;
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

// 인스타가 이미지와 영상을 가져갈 공개 경로
app.get("/media/:name", (req, res) => {
  const b = imageBuffers.get(req.params.name);
  if (!b) return res.sendStatus(404);
  res.type(req.params.name.endsWith(".mp4") ? "video/mp4" : "image/jpeg");
  res.setHeader("Content-Length", String(b.length));
  res.send(b);
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
