export type Cat = "anime" | "game" | "jpop";

export type Source =
  | { kind: "rss"; name: string; url: string; cat: Cat; filter?: string }
  | { kind: "reddit"; name: string; sub: string; cat: Cat };

export type Article = {
  title: string;
  link: string;
  date: number;
  snippet: string;
  source: string;
  cat: Cat;
  score?: number;
  images: string[];
  titleKo?: string;
  snippetKo?: string;
};

export type Topic = {
  idx: number;
  title: string;
  angle: string;
  why: string;
  cat: Cat;
  entity: string; // 공식 원제 (영문/일문): 이미지 API 검색용
  sourceName?: string;
  sourceUrl?: string;
  articleImages?: string[];
};

export type SlideStyle = {
  aspectRatio?: "4:5" | "1:1" | "9:16" | "16:9" | "custom";
  width?: number;
  height?: number;
  imageRatio?: number; // 0.3 ~ 1.0 (배경 이미지 높이 점유율, 기본 1.0)
  imageFit?: "cover" | "contain"; // 기본 "cover"
  imageScale?: number; // 1.0 ~ 2.0 확대 (기본 1.0)
  imagePosition?: "attention" | "top" | "center" | "bottom";
  imageOffsetX?: number; // 0 ~ 100% (기본 50)
  imageOffsetY?: number; // 0 ~ 100% (기본 50)
  overlayOpacity?: number; // 0.0 ~ 1.0 어두움 오버레이 (기본 0.85)
  customImageUrl?: string;
};

export type Pending =
  | { kind: "photo"; slideIdx: number }
  | { kind: "editText"; slideIdx: number }
  | { kind: "addPage"; afterIdx: number }
  | { kind: "caption" }
  | { kind: "music" };

export type SlideContent = {
  headline: string;
  body: string;
  imageQuery: string;
  style?: SlideStyle;
};

export type JobStatus =
  | "idle"
  | "collecting"
  | "proposing"
  | "generating"
  | "review"
  | "published"
  | "canceled"
  | "error";

export type Job = {
  id: string;
  createdAt: number;
  status: JobStatus;
  topic?: Topic;
  topics?: Topic[];
  slides?: SlideContent[];
  slideStyles?: SlideStyle[];
  cardRatio?: "4:5" | "1:1" | "9:16" | "16:9" | "custom";
  customWidth?: number;
  customHeight?: number;
  caption?: string;
  slideImgs?: (Buffer | null)[];
  slideImgUrls?: string[];
  imageFiles?: string[];
  renderedSlideDataUrls?: string[];
  usedImageUrls?: string[];
  slideCandidates?: string[][];
  candidateCursor?: number[];
  pending?: Pending;
  music?: { name: string; start: number };
  videoFile?: string;
  error?: string;
};

export type ServerConfig = {
  telegramBotToken: string;
  telegramChatId: string;
  telegramSecret: string;
  publicBaseUrl: string;
  tgMode: "webhook" | "polling" | "off";
  cronSecret: string;
  handle: string;
  braveApiKey: string;
  maxAgeHours: number;
  textModel: string;
  igUserId: string;
  igAccessToken: string;
};

export type LogEntry = {
  id: string;
  time: string;
  level: "info" | "warn" | "error" | "success";
  message: string;
};
