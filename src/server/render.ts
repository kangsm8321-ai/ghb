import sharp from "sharp";
import path from "path";
import fs from "fs";
import { Resvg } from "@resvg/resvg-js";
import type { Cat, SlideStyle } from "./types.js";

const FONT_PATHS = [
  path.resolve("fonts/Pretendard-Bold.otf"),
  path.resolve("fonts/Pretendard-Regular.otf"),
].filter((f) => fs.existsSync(f));

export const CAT_COLOR: Record<Cat, string> = {
  anime: "#38bdf8", // Sky blue
  game: "#a3e635", // Vibrant Lime
  jpop: "#f472b6", // Neon Pink
};

export const CAT_LABEL: Record<Cat, string> = {
  anime: "ANIME",
  game: "GAME",
  jpop: "J-POP",
};

const esc = (s: string) =>
  (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  }[c] || c));

// 한글 글자폭(1.0)과 ASCII 글자폭(0.55)을 고려한 문자열 길이 계산
const vlen = (s: string) =>
  [...s].reduce((n, c) => n + (/[\x00-\xff]/.test(c) ? 0.55 : 1), 0);

function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  let cur = "";
  const words = (text || "").split(/\s+/);
  for (const w of words) {
    if (cur && vlen(cur + " " + w) > max) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export type SlideRenderOpts = {
  img: Buffer | null;
  headline: string;
  body: string;
  index: number;
  total: number;
  cat: Cat;
  source?: string;
  handle?: string;
  style?: SlideStyle;
  // 단일 오버라이드 옵션
  width?: number;
  height?: number;
  imageRatio?: number; // 0.3 ~ 1.0 (배경 이미지 높이 점유율, 기본 1.0)
  imageFit?: "cover" | "contain";
  imageScale?: number; // 1.0 ~ 2.5
  imagePosition?: "attention" | "top" | "center" | "bottom";
  imageOffsetY?: number; // 0 ~ 100%
  overlayOpacity?: number; // 0.0 ~ 1.0
};

export async function renderSlide(opts: SlideRenderOpts): Promise<Buffer> {
  const { img, index, total, cat } = opts;
  const cover = index === 0;

  // 비율 및 해상도 계산 (4:5, 1:1, 9:16, 16:9 또는 custom)
  const st = opts.style || {};
  let W = opts.width || st.width || 1080;
  let H = opts.height || st.height || 1350;

  if (st.aspectRatio === "1:1") {
    W = 1080;
    H = 1080;
  } else if (st.aspectRatio === "9:16") {
    W = 1080;
    H = 1920;
  } else if (st.aspectRatio === "16:9") {
    W = 1920;
    H = 1080;
  } else if (st.aspectRatio === "4:5") {
    W = 1080;
    H = 1350;
  }

  // 배경 이미지 비율 및 컨트롤 속성
  const imgRatio = Math.max(0.25, Math.min(1.0, opts.imageRatio ?? st.imageRatio ?? 1.0));
  const imgH = Math.round(H * imgRatio);
  const fitMode = opts.imageFit || st.imageFit || "cover";
  const scale = Math.max(1.0, Math.min(2.5, opts.imageScale ?? st.imageScale ?? 1.0));
  const overlayAlpha = Math.max(0.1, Math.min(1.0, opts.overlayOpacity ?? st.overlayOpacity ?? 0.85));
  const imagePos = opts.imagePosition || st.imagePosition || "attention";
  const offsetYPercent = opts.imageOffsetY ?? st.imageOffsetY ?? 50;

  const scaleFactor = W / 1080;
  const isSplitLayout = imgRatio < 0.94;

  const hSize = Math.round((cover ? 74 : 58) * scaleFactor);
  const hLH = Math.round(hSize * 1.25);
  const bSize = Math.round((cover ? 36 : 34) * scaleFactor);
  const bLH = Math.round(bSize * 1.55);

  const maxCharsH = Math.max(10, Math.floor(W / (cover ? 80 : 66)));
  const maxCharsB = Math.max(18, Math.floor(W / 44));

  const hLines = wrap(opts.headline, maxCharsH);
  const bLines = wrap(opts.body, maxCharsB);

  // 텍스트 위치 계산
  const bottom = H - Math.round(110 * scaleFactor);
  const bodyTop = bottom - bLines.length * bLH;
  const headTop = isSplitLayout
    ? Math.max(imgH + Math.round(40 * scaleFactor), bodyTop - Math.round(45 * scaleFactor) - hLines.length * hLH)
    : bodyTop - Math.round(45 * scaleFactor) - hLines.length * hLH;

  const color = CAT_COLOR[cat] || "#38bdf8";
  const badgeLabel = cover ? `BREAKING · ${CAT_LABEL[cat]}` : CAT_LABEL[cat];
  const badgeWidth = Math.round((cover ? 270 : 180) * scaleFactor);
  const badgeHeight = Math.round(48 * scaleFactor);
  const badgeRadius = Math.round(badgeHeight / 2);

  // SVG 텍스트 & 그라디언트 오버레이 생성
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#05070d" stop-opacity="0"/>
      <stop offset="0.3" stop-color="#05070d" stop-opacity="${(overlayAlpha * 0.45).toFixed(2)}"/>
      <stop offset="0.75" stop-color="#05070d" stop-opacity="${(overlayAlpha * 0.92).toFixed(2)}"/>
      <stop offset="1" stop-color="#05070d" stop-opacity="${overlayAlpha.toFixed(2)}"/>
    </linearGradient>
    <linearGradient id="seam" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#080c18" stop-opacity="0"/>
      <stop offset="1" stop-color="#080c18" stop-opacity="1"/>
    </linearGradient>
    <linearGradient id="topShadow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#05070d" stop-opacity="${(overlayAlpha * 0.8).toFixed(2)}"/>
      <stop offset="1" stop-color="#05070d" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <!-- 상단 네비게이션 가독성을 위한 은은한 그림자 -->
  <rect x="0" y="0" width="${W}" height="${Math.round(200 * scaleFactor)}" fill="url(#topShadow)"/>

  ${
    isSplitLayout
      ? `
    <!-- 이미지 하단 경계 부드러운 그라디언트 페이드 -->
    <rect x="0" y="${Math.max(0, imgH - Math.round(140 * scaleFactor))}" width="${W}" height="${Math.round(140 * scaleFactor)}" fill="url(#seam)"/>
    <!-- 텍스트 영역 전용 다크 배경 -->
    <rect x="0" y="${imgH}" width="${W}" height="${H - imgH}" fill="#080c18"/>
    <!-- 세련된 네온 구분선 -->
    <line x1="${Math.round(64 * scaleFactor)}" y1="${imgH}" x2="${W - Math.round(64 * scaleFactor)}" y2="${imgH}" stroke="${color}" stroke-opacity="0.35" stroke-width="2"/>
    `
      : `
    <!-- 풀스크린 텍스트 가독성 그라디언트 -->
    <rect x="0" y="${Math.max(0, headTop - Math.round(220 * scaleFactor))}" width="${W}" height="${H - Math.max(0, headTop - Math.round(220 * scaleFactor))}" fill="url(#g)"/>
    `
  }

  <!-- 상단 카테고리 뱃지 -->
  <rect x="${Math.round(64 * scaleFactor)}" y="${Math.round(64 * scaleFactor)}" width="${badgeWidth}" height="${badgeHeight}" rx="${badgeRadius}" fill="${color}"/>
  <text x="${Math.round((64 + badgeWidth / 2) * scaleFactor)}" y="${Math.round(64 * scaleFactor + badgeHeight / 2)}" font-family="Pretendard, sans-serif" font-weight="700" font-size="${Math.round(22 * scaleFactor)}" fill="#05070d" text-anchor="middle" dominant-baseline="central">${esc(badgeLabel)}</text>

  <!-- 슬라이드 페이지 카운터 (예: 01 / 05) -->
  <text x="${W - Math.round(64 * scaleFactor)}" y="${Math.round(64 * scaleFactor + badgeHeight / 2)}" font-family="Pretendard, sans-serif" font-weight="700" font-size="${Math.round(24 * scaleFactor)}" fill="#ffffff" text-anchor="end" dominant-baseline="central">${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}</text>

  <!-- 헤드라인 강조 액센트 바 -->
  <rect x="${Math.round(64 * scaleFactor)}" y="${headTop - Math.round(24 * scaleFactor)}" width="${Math.round(88 * scaleFactor)}" height="${Math.round(8 * scaleFactor)}" rx="4" fill="${color}"/>

  <!-- 헤드라인 텍스트 -->
  ${hLines
    .map(
      (l, i) =>
        `<text x="${Math.round(64 * scaleFactor)}" y="${headTop + hSize + i * hLH}" font-family="Pretendard, sans-serif" font-weight="700" font-size="${hSize}" fill="#ffffff">${esc(l)}</text>`
    )
    .join("")}

  <!-- 본문 텍스트 -->
  ${bLines
    .map(
      (l, i) =>
        `<text x="${Math.round(64 * scaleFactor)}" y="${bodyTop + bSize + i * bLH}" font-family="Pretendard, sans-serif" font-weight="400" font-size="${bSize}" fill="#f1f5f9">${esc(l)}</text>`
    )
    .join("")}

  <!-- 푸터: 출처 및 계정 핸들 -->
  <text x="${Math.round(64 * scaleFactor)}" y="${H - Math.round(55 * scaleFactor)}" font-family="Pretendard, sans-serif" font-size="${Math.round(20 * scaleFactor)}" fill="#94a3b8">${esc(opts.source ? `출처: ${opts.source}` : "")}</text>
  <text x="${W - Math.round(64 * scaleFactor)}" y="${H - Math.round(55 * scaleFactor)}" font-family="Pretendard, sans-serif" font-weight="700" font-size="${Math.round(22 * scaleFactor)}" fill="#cbd5e1" text-anchor="end">${esc(opts.handle || "@animemag.kr")}</text>
</svg>`;

  let overlayPng: Buffer;
  try {
    const resvg = new Resvg(svg, {
      font: {
        fontFiles: FONT_PATHS,
        loadSystemFonts: false,
        defaultFontFamily: "Pretendard",
      },
    });
    overlayPng = resvg.render().asPng();
  } catch (err) {
    const resvg = new Resvg(svg, {
      font: {
        loadSystemFonts: true,
        defaultFontFamily: "sans-serif",
      },
    });
    overlayPng = resvg.render().asPng();
  }

  // 배경 이미지 처리
  let base: Buffer;
  if (img) {
    try {
      let processedImg: Buffer;

      if (fitMode === "contain") {
        // 배경은 블러 처리된 앰비언트 이미지, 전경은 비율 유지 contain
        const blurredBg = await sharp(img)
          .resize(W, imgH, { fit: "cover" })
          .blur(30)
          .modulate({ brightness: 0.35 })
          .toBuffer();

        const containedFg = await sharp(img)
          .resize(W, imgH, {
            fit: "contain",
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .png()
          .toBuffer();

        processedImg = await sharp(blurredBg)
          .composite([{ input: containedFg, gravity: "center" }])
          .toBuffer();
      } else {
        // cover 모드 (확대 스케일 및 포지션 조절)
        if (scale > 1.02) {
          const scaledW = Math.round(W * scale);
          const scaledH = Math.round(imgH * scale);
          const offsetYNorm = offsetYPercent / 100;
          const top = Math.max(0, Math.min(scaledH - imgH, Math.round((scaledH - imgH) * offsetYNorm)));
          const left = Math.max(0, Math.round((scaledW - W) / 2));

          processedImg = await sharp(img)
            .resize(scaledW, scaledH, { fit: "cover" })
            .extract({ left, top, width: W, height: imgH })
            .toBuffer();
        } else {
          let pos: any = sharp.strategy.attention;
          if (imagePos === "top") pos = sharp.gravity.north;
          else if (imagePos === "bottom") pos = sharp.gravity.south;
          else if (imagePos === "center") pos = sharp.gravity.center;

          processedImg = await sharp(img)
            .resize(W, imgH, { fit: "cover", position: pos })
            .toBuffer();
        }
      }

      if (isSplitLayout) {
        // 상단에만 이미지를 배치하고 하단은 솔리드 다크 캔버스
        const canvas = await sharp({
          create: {
            width: W,
            height: H,
            channels: 3,
            background: "#080c18",
          },
        })
          .png()
          .toBuffer();

        base = await sharp(canvas)
          .composite([{ input: processedImg, top: 0, left: 0 }])
          .toBuffer();
      } else {
        base = processedImg;
      }
    } catch {
      base = await sharp({
        create: {
          width: W,
          height: H,
          channels: 3,
          background: "#080c18",
        },
      })
        .png()
        .toBuffer();
    }
  } else {
    base = await sharp({
      create: {
        width: W,
        height: H,
        channels: 3,
        background: "#080c18",
      },
    })
      .png()
      .toBuffer();
  }

  return sharp(base)
    .composite([{ input: overlayPng }])
    .jpeg({ quality: 92 })
    .toBuffer();
}
