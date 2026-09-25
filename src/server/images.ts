import sharp from "sharp";
import { UA, extractImgs } from "./collect.js";
import type { Topic } from "./types.js";

const enc = encodeURIComponent;

const getJson = async (u: string, h: Record<string, string> = {}) => {
  try {
    const r = await fetch(u, {
      headers: { "User-Agent": UA, ...h },
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
};

// ── 소스별 이미지 후보 수집 ──

const BLOCK_HOSTS = [
  "google.com",
  "gstatic.com",
  "googleusercontent.com",
  "googleapis.com",
  "vertexaisearch.cloud.google.com",
  "x.com",
  "twitter.com",
  "abs.twimg.com",
  "redditstatic.com",
  "facebook.com",
];

export function isBlockedImageUrl(u: string): boolean {
  try {
    const url = new URL(u);
    const h = url.hostname;
    if (BLOCK_HOSTS.some((b) => h === b || h.endsWith("." + b))) return true;
    return /logo|favicon|icon|avatar|sprite|placeholder|noimage|no_image|default[-_]?(og|share|image)|\.svg(\?|$)|\.gif(\?|$)/i.test(
      url.pathname
    );
  } catch {
    return true;
  }
}

const isBlockedPage = (u: string) =>
  /(^|\.)(google\.com|x\.com|twitter\.com)$/i.test(new URL(u).hostname);

async function articleImages(link?: string): Promise<string[]> {
  if (!link) return [];
  try {
    if (isBlockedPage(link) && !/vertexaisearch/.test(link)) return [];
    const res = await fetch(link, {
      headers: { "User-Agent": UA },
      redirect: "follow",
      signal: AbortSignal.timeout(6000),
    });
    // 리다이렉트 후에도 구글/X 페이지면 og:image 가 로고이므로 쓰지 않음
    if (!res.ok || isBlockedPage(res.url)) return [];
    const html = await res.text();
    const og = [
      ...html.matchAll(
        /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)/gi
      ),
    ].map((m) => m[1]);
    const body = html.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? html;
    return [...og, ...extractImgs(body, res.url)]
      .filter((u) => !isBlockedImageUrl(u))
      .slice(0, 15);
  } catch {
    return [];
  }
}

// 애니: MyAnimeList 비공식 Jikan API (API 키 불필요)
async function jikan(q: string): Promise<string[]> {
  if (!q) return [];
  try {
    const s = await getJson(`https://api.jikan.moe/v4/anime?q=${enc(q)}&limit=2`);
    const a = s?.data?.[0];
    if (!a) return [];
    const p = await getJson(`https://api.jikan.moe/v4/anime/${a.mal_id}/pictures`);
    const pics = (p?.data ?? []).map((x: any) => x.jpg?.large_image_url || x.jpg?.image_url);
    return [
      a.images?.jpg?.large_image_url || a.images?.jpg?.image_url,
      ...pics,
    ].filter(Boolean);
  } catch {
    return [];
  }
}

// 게임: Steam 공식 스토어 API 스크린샷
async function steam(q: string): Promise<string[]> {
  if (!q) return [];
  try {
    const s = await getJson(
      `https://store.steampowered.com/api/storesearch/?term=${enc(q)}&l=english&cc=US`
    );
    const id = s?.items?.[0]?.id;
    if (!id) return [];
    const appDetails = await getJson(
      `https://store.steampowered.com/api/appdetails?appids=${id}`
    );
    const d = appDetails?.[id]?.data;
    const screenshots = (d?.screenshots ?? []).map((x: any) => x.path_full);
    const headerImg = d?.header_image;
    return [headerImg, ...screenshots].filter(Boolean);
  } catch {
    return [];
  }
}

// JPOP / 음악: iTunes Search API 고해상도 1200x1200bb 앨범 아트
async function itunes(q: string): Promise<string[]> {
  if (!q) return [];
  try {
    const j = await getJson(
      `https://itunes.apple.com/search?term=${enc(q)}&country=JP&entity=album&limit=6`
    );
    return (j?.results ?? [])
      .map((r: any) =>
        r.artworkUrl100
          ? r.artworkUrl100.replace("100x100bb", "1200x1200bb")
          : ""
      )
      .filter(Boolean);
  } catch {
    return [];
  }
}

// 범용 이미지 검색 (선택사항, BRAVE_API_KEY 환경변수가 있을 때)
async function brave(q: string, braveKey?: string): Promise<string[]> {
  const key = braveKey || process.env.BRAVE_API_KEY;
  if (!key || !q) return [];
  try {
    const j = await getJson(
      `https://api.search.brave.com/res/v1/images/search?q=${enc(q)}&count=12&safesearch=strict`,
      { "X-Subscription-Token": key, Accept: "application/json" }
    );
    return (j?.results ?? []).map((x: any) => x.properties?.url).filter(Boolean);
  } catch {
    return [];
  }
}

// ── 다운로드 + 품질 검사 + 유사 이미지 판별 (dhash) ──

const downloadCache = new Map<string, Buffer | null>();

export async function downloadImage(url: string): Promise<Buffer | null> {
  if (downloadCache.has(url)) return downloadCache.get(url)!;
  let out: Buffer | null = null;
  try {
    if (!isBlockedImageUrl(url)) {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, Referer: new URL(url).origin },
        signal: AbortSignal.timeout(8000),
      });
      const cType = r.headers.get("content-type") || "";
      if (r.ok && (cType.startsWith("image/") || /\.(jpe?g|png|webp)/i.test(url))) {
        const b = Buffer.from(await r.arrayBuffer());
        const m = await sharp(b).metadata();
        const w = m.width ?? 0,
          h = m.height ?? 0,
          ar = w / (h || 1);
        // 작은 썸네일이나 배너형(너무 가로·세로로 긴) 이미지 제외
        if (w >= 500 && h >= 350 && ar < 2.6 && ar > 0.4) {
          // 로고·단색 그래픽은 엔트로피가 낮음 (사진은 보통 6~7.5). 필요하면 기준값 조절
          const { entropy } = await sharp(b).stats();
          if (entropy >= 4.5) out = b;
        }
      }
    }
  } catch {
    out = null;
  }
  downloadCache.set(url, out);
  return out;
}

// 64-bit difference hash (dhash 9x8)
export async function dhash(b: Buffer): Promise<bigint> {
  try {
    const px = await sharp(b)
      .grayscale()
      .resize(9, 8, { fit: "fill" })
      .raw()
      .toBuffer();
    let h = 0n;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        h = (h << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
      }
    }
    return h;
  } catch {
    return 0n;
  }
}

export const ham = (a: bigint, b: bigint): number => {
  let x = a ^ b;
  let c = 0;
  while (x) {
    c += Number(x & 1n);
    x >>= 1n;
  }
  return c;
};

export async function pickSlideImages(
  topic: Topic,
  slides: { imageQuery: string }[],
  excludeUrls: string[] = [],
  braveKey?: string,
  log?: (m: string) => void
): Promise<{ bufs: (Buffer | null)[]; urls: string[]; cands: string[][] }> {
  log?.(`🖼 "${topic.title}" 슬라이드별 이미지 수집 중...`);

  const fromArticle = [
    ...(topic.articleImages ?? []),
    ...(await articleImages(topic.sourceUrl)),
  ];

  const fromApi =
    topic.cat === "anime"
      ? await jikan(topic.entity)
      : topic.cat === "game"
      ? await steam(topic.entity)
      : await itunes(topic.entity);

  const usedHash: bigint[] = [];
  const usedUrl = new Set<string>(excludeUrls);
  const bufs: (Buffer | null)[] = [];
  const urls: string[] = [];
  const cands: string[][] = [];

  for (let i = 0; i < slides.length; i++) {
    const isCover = i === 0;
    // 표지 = 기사 대표 이미지 + 공식 API 우선
    // 본문 = 슬라이드 검색어 → 공식 API → 기사 이미지 순
    const braveCands = await brave(
      `${topic.entity} ${slides[i].imageQuery || ""}`.trim(),
      braveKey
    );

    const list = [
      ...new Set(
        (isCover
          ? [...fromArticle, ...fromApi, ...braveCands]
          : [...braveCands, ...fromApi, ...fromArticle]
        ).filter((u) => u && !isBlockedImageUrl(u))
      ),
    ];
    cands.push(list); // 텔레그램 "다음 후보 사진" 버튼에서 사용

    let got: Buffer | null = null;
    let selectedUrl = "";

    for (const u of list) {
      if (usedUrl.has(u)) continue;
      const b = await downloadImage(u);
      if (!b) continue;

      const h = await dhash(b);
      // 거의 같은 사진이면 건너뜀 (Hamming 거리 8 이하)
      if (usedHash.some((x) => ham(x, h) <= 8)) continue;

      usedHash.push(h);
      usedUrl.add(u);
      selectedUrl = u;
      got = b;
      break;
    }

    bufs.push(got);
    urls.push(selectedUrl);
  }

  // 사진이 모자라면: 이미 확보한 사진 풀에서 다른 부분을 크롭하여 슬라이드 채움
  const pool = bufs.filter(Boolean) as Buffer[];
  const gravities = ["north", "south", "east", "west", "centre"] as const;

  for (let i = 0; i < bufs.length; i++) {
    if (!bufs[i] && pool.length > 0) {
      const src = pool[i % pool.length];
      const m = await sharp(src).metadata();
      const w = m.width || 1080;
      bufs[i] = await sharp(src)
        .resize(Math.round(w * 1.5), null)
        .resize(1080, 1350, {
          fit: "cover",
          position: gravities[i % gravities.length],
        })
        .toBuffer();
      urls[i] = urls[i % pool.length] || "";
    }
  }

  log?.(
    `✔ ${bufs.filter(Boolean).length}장 배정 (후보 총 ${cands.flat().length}개)`
  );
  return { bufs, urls, cands };
}
