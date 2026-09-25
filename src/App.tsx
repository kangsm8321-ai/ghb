import React, { useState, useEffect, useRef } from "react";
import {
  Sparkles,
  RefreshCw,
  Download,
  Send,
  Sliders,
  Radio,
  FileText,
  Image as ImageIcon,
  ExternalLink,
  Check,
  Copy,
  ChevronLeft,
  ChevronRight,
  Flame,
  Gamepad2,
  Tv,
  Music,
  Terminal,
  AlertCircle,
  PlusCircle,
  Clock,
  Layers,
  Edit3,
  Archive,
  Eye,
  Languages,
} from "lucide-react";
import type {
  Article,
  Job,
  Topic,
  ServerConfig,
  LogEntry,
  Cat,
} from "./types.js";

const CAT_COLORS: Record<Cat, { bg: string; text: string; border: string; glow: string }> = {
  anime: {
    bg: "bg-sky-500/10",
    text: "text-sky-400",
    border: "border-sky-500/30",
    glow: "shadow-[0_0_15px_rgba(56,189,248,0.25)]",
  },
  game: {
    bg: "bg-lime-500/10",
    text: "text-lime-400",
    border: "border-lime-500/30",
    glow: "shadow-[0_0_15px_rgba(163,230,53,0.25)]",
  },
  jpop: {
    bg: "bg-pink-500/10",
    text: "text-pink-400",
    border: "border-pink-500/30",
    glow: "shadow-[0_0_15px_rgba(244,114,182,0.25)]",
  },
};

export default function App() {
  const [activeTab, setActiveTab] = useState<"studio" | "radar" | "settings" | "history">("studio");
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [articles, setArticles] = useState<Article[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [selectedSlideIndex, setSelectedSlideIndex] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // 필터 및 모달 상태
  const [selectedCatFilter, setSelectedCatFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showKorean, setShowKorean] = useState(true);
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [isTestingTelegram, setIsTestingTelegram] = useState(false);
  const [translatingLinks, setTranslatingLinks] = useState<Set<string>>(new Set());
  const [customForm, setCustomForm] = useState({
    title: "",
    entity: "",
    cat: "anime" as Cat,
    angle: "",
    imageUrl: "",
    sourceName: "",
  });

  // 로딩 상태들
  const [isCollecting, setIsCollecting] = useState(false);
  const [isProposing, setIsProposing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isUpdatingSlide, setIsUpdatingSlide] = useState(false);
  const [isSendingTelegram, setIsSendingTelegram] = useState(false);
  const [copiedCaption, setCopiedCaption] = useState(false);
  const [customHint, setCustomHint] = useState("");

  // 편집 폼 상태
  const [editHeadline, setEditHeadline] = useState("");
  const [editBody, setEditBody] = useState("");

  const logsEndRef = useRef<HTMLDivElement>(null);

  // 초기 데이터 로드
  useEffect(() => {
    fetchConfig();
    fetchArticles();
    fetchJobs();
    fetchLogs();

    const interval = setInterval(() => {
      fetchLogs();
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  // 활성 슬라이드 변경 시 편집 필드 동기화
  useEffect(() => {
    if (activeJob?.slides && activeJob.slides[selectedSlideIndex]) {
      setEditHeadline(activeJob.slides[selectedSlideIndex].headline);
      setEditBody(activeJob.slides[selectedSlideIndex].body);
    }
  }, [activeJob, selectedSlideIndex]);

  const fetchConfig = async () => {
    try {
      const res = await fetch("/api/config");
      if (res.ok) setConfig(await res.json());
    } catch {}
  };

  const fetchArticles = async () => {
    try {
      const res = await fetch("/api/articles");
      if (res.ok) {
        const data = await res.json();
        setArticles(data.articles || []);
      }
    } catch {}
  };

  const fetchJobs = async () => {
    try {
      const res = await fetch("/api/jobs");
      if (res.ok) {
        const data = await res.json();
        setJobs(data.jobs || []);
      }
    } catch {}
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch("/api/logs");
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs || []);
      }
    } catch {}
  };

  // 뉴스 수집 트리거
  const handleCollectNews = async () => {
    setIsCollecting(true);
    try {
      const res = await fetch("/api/collect", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setArticles(data.articles || []);
        fetchLogs();
      }
    } catch (e: any) {
      alert(`수집 오류: ${e.message}`);
    } finally {
      setIsCollecting(false);
    }
  };

  // AI 5선 토픽 선별
  const handleProposeTopics = async (hint?: string) => {
    setIsProposing(true);
    setActiveTab("studio");
    try {
      const res = await fetch("/api/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hint }),
      });
      const data = await res.json();
      if (data.ok) {
        setActiveJob(data.job);
        fetchJobs();
      }
    } catch (e: any) {
      alert(`선별 오류: ${e.message}`);
    } finally {
      setIsProposing(false);
    }
  };

  // 카드뉴스 전체 자동 제작
  const handleGenerateJob = async (topic: Topic) => {
    setIsGenerating(true);
    setActiveTab("studio");
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      const data = await res.json();
      if (data.ok) {
        setActiveJob(data.job);
        setSelectedSlideIndex(0);
        fetchJobs();
      } else {
        alert(data.error || "제작 중 오류 발생");
      }
    } catch (e: any) {
      alert(`제작 오류: ${e.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  // 직접 기획 제작
  const handleCustomGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customForm.title) return;
    setIsGenerating(true);
    setShowCustomModal(false);
    setActiveTab("studio");
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ custom: customForm }),
      });
      const data = await res.json();
      if (data.ok) {
        setActiveJob(data.job);
        setSelectedSlideIndex(0);
        fetchJobs();
      }
    } catch (e: any) {
      alert(`제작 오류: ${e.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  // 슬라이드 텍스트 즉시 수정 및 재렌더링
  const handleUpdateSlide = async () => {
    if (!activeJob) return;
    setIsUpdatingSlide(true);
    try {
      const res = await fetch(`/api/jobs/${activeJob.id}/update-slide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          index: selectedSlideIndex,
          headline: editHeadline,
          body: editBody,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setActiveJob(data.job);
      }
    } catch (e: any) {
      alert(`슬라이드 업데이트 실패: ${e.message}`);
    } finally {
      setIsUpdatingSlide(false);
    }
  };

  // 다른 사진으로 교체
  const handleRegenerateImages = async () => {
    if (!activeJob) return;
    setIsGenerating(true);
    try {
      const res = await fetch(`/api/jobs/${activeJob.id}/regenerate-images`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.ok) {
        setActiveJob(data.job);
      }
    } catch (e: any) {
      alert(`사진 교체 오류: ${e.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  // 원고 재작성
  const handleRewriteContent = async () => {
    if (!activeJob) return;
    setIsGenerating(true);
    try {
      const res = await fetch(`/api/jobs/${activeJob.id}/rewrite`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.ok) {
        setActiveJob(data.job);
      }
    } catch (e: any) {
      alert(`원고 재작성 오류: ${e.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  // 텔레그램 앨범 전송
  const handleSendTelegram = async () => {
    if (!activeJob) return;
    setIsSendingTelegram(true);
    try {
      const res = await fetch(`/api/jobs/${activeJob.id}/send-telegram`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.ok) {
        alert("텔레그램으로 카드뉴스 앨범이 전송되었습니다! ✅");
      } else {
        alert(data.error || "텔레그램 전송 실패");
      }
    } catch (e: any) {
      alert(`전송 오류: ${e.message}`);
    } finally {
      setIsSendingTelegram(false);
    }
  };

  // 캡션 복사
  const handleCopyCaption = () => {
    if (!activeJob?.caption) return;
    navigator.clipboard.writeText(activeJob.caption);
    setCopiedCaption(true);
    setTimeout(() => setCopiedCaption(false), 2000);
  };

  // 단일 슬라이드 다운로드
  const handleDownloadSingleSlide = () => {
    if (!activeJob?.renderedSlideDataUrls?.[selectedSlideIndex]) return;
    const a = document.createElement("a");
    a.href = activeJob.renderedSlideDataUrls[selectedSlideIndex];
    a.download = `${activeJob.topic?.title || "card"}_slide_${selectedSlideIndex + 1}.jpg`;
    a.click();
  };

  // 설정 저장
  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!config) return;
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        alert("설정이 저장되었습니다.");
        fetchConfig();
      }
    } catch (e: any) {
      alert("설정 저장 실패: " + e.message);
    }
  };

  // 텔레그램 연동 테스트 (ID와 API 키만으로 즉시 전송 테스트)
  const handleTestTelegramConnection = async () => {
    if (!config?.telegramBotToken || !config?.telegramChatId) {
      alert("텔레그램 봇 토큰(API 키)과 Chat ID를 먼저 입력해 주세요.");
      return;
    }
    setIsTestingTelegram(true);
    try {
      const res = await fetch("/api/telegram/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          telegramBotToken: config.telegramBotToken,
          telegramChatId: config.telegramChatId,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        alert("🎉 텔레그램으로 테스트 메시지가 성공적으로 전송되었습니다! 텔레그램 앱을 확인해 보세요.");
        fetchConfig();
        fetchLogs();
      } else {
        alert("전송 실패: " + (data.error || "봇 토큰과 Chat ID를 확인해 주세요."));
      }
    } catch (e: any) {
      alert("연동 오류: " + e.message);
    } finally {
      setIsTestingTelegram(false);
    }
  };

  // 텔레그램 웹훅 등록
  const handleSetupWebhook = async () => {
    try {
      const res = await fetch("/tg/setup");
      const data = await res.json();
      alert(`텔레그램 웹훅 설정 결과: ${JSON.stringify(data)}`);
    } catch (e: any) {
      alert("웹훅 등록 실패: " + e.message);
    }
  };

  // 개별 기사 즉시 한국어 번역
  const handleTranslateArticle = async (art: Article) => {
    setTranslatingLinks((prev) => new Set(prev).add(art.link));
    try {
      const res = await fetch("/api/translate-article", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          link: art.link,
          title: art.title,
          snippet: art.snippet,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setArticles((prev) =>
          prev.map((a) =>
            a.link === art.link
              ? { ...a, titleKo: data.titleKo, snippetKo: data.snippetKo }
              : a
          )
        );
      }
    } catch (e: any) {
      console.error("단일 기사 번역 실패:", e);
    } finally {
      setTranslatingLinks((prev) => {
        const next = new Set(prev);
        next.delete(art.link);
        return next;
      });
    }
  };

  // 필터된 기사 목록 (한국어 번역 및 원문 검색 지원)
  const filteredArticles = articles.filter((a) => {
    const matchCat =
      selectedCatFilter === "all"
        ? true
        : selectedCatFilter === "reddit"
        ? a.source.startsWith("Reddit")
        : selectedCatFilter === "x"
        ? a.source.includes("X")
        : a.cat === selectedCatFilter;
    const fullText = (
      a.title +
      " " +
      (a.titleKo || "") +
      " " +
      a.snippet +
      " " +
      (a.snippetKo || "") +
      " " +
      a.source
    ).toLowerCase();
    const matchSearch = searchQuery === "" ? true : fullText.includes(searchQuery.toLowerCase());
    return matchCat && matchSearch;
  });

  return (
    <div className="min-h-screen bg-[#05070d] text-slate-100 flex flex-col font-sans">
      {/* ── Top Navigation Bar ── */}
      <header className="border-b border-slate-800/80 bg-[#080d1a]/90 backdrop-blur sticky top-0 z-40 px-4 lg:px-6 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          {/* Logo & Brand */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-sky-500 via-indigo-500 to-pink-500 p-[2px] shadow-[0_0_20px_rgba(56,189,248,0.3)]">
              <div className="w-full h-full bg-[#070b14] rounded-[10px] flex items-center justify-center">
                <Flame className="w-5 h-5 text-sky-400" />
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-extrabold text-base lg:text-lg tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-sky-400 via-indigo-200 to-pink-400">
                  SUBCULTURE MAGAZINE BOT
                </h1>
                <span className="text-[10px] uppercase font-bold tracking-widest px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/30">
                  AUTO v2.0
                </span>
              </div>
              <p className="text-xs text-slate-400 hidden sm:block">
                애니메이션 · 서브컬처 게임 · J-POP 자동 수집 및 고해상도 카드뉴스 제작 스튜디오
              </p>
            </div>
          </div>

          {/* Nav Tabs */}
          <nav className="flex items-center gap-1 bg-slate-900/80 p-1 rounded-xl border border-slate-800 text-xs">
            <button
              onClick={() => setActiveTab("studio")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition ${
                activeTab === "studio"
                  ? "bg-sky-500 text-white shadow-[0_0_12px_rgba(56,189,248,0.4)]"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              스튜디오
            </button>
            <button
              onClick={() => setActiveTab("radar")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition ${
                activeTab === "radar"
                  ? "bg-sky-500 text-white shadow-[0_0_12px_rgba(56,189,248,0.4)]"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <Radio className="w-3.5 h-3.5" />
              뉴스 레이더
              {articles.length > 0 && (
                <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] bg-slate-800 text-slate-300">
                  {articles.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab("history")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition ${
                activeTab === "history"
                  ? "bg-sky-500 text-white shadow-[0_0_12px_rgba(56,189,248,0.4)]"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <Archive className="w-3.5 h-3.5" />
              히스토리
            </button>
            <button
              onClick={() => setActiveTab("settings")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition ${
                activeTab === "settings"
                  ? "bg-sky-500 text-white shadow-[0_0_12px_rgba(56,189,248,0.4)]"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <Sliders className="w-3.5 h-3.5" />
              설정 & 텔레그램
            </button>
          </nav>

          {/* Quick Action Buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowCustomModal(true)}
              className="hidden md:flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
            >
              <PlusCircle className="w-3.5 h-3.5 text-sky-400" />
              직접 기획
            </button>
            <button
              onClick={() => handleProposeTopics()}
              disabled={isProposing}
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 text-white shadow-[0_0_15px_rgba(56,189,248,0.3)] transition disabled:opacity-50"
            >
              <Sparkles className={`w-3.5 h-3.5 ${isProposing ? "animate-spin" : ""}`} />
              {isProposing ? "AI 선별 중..." : "AI 5선 토픽"}
            </button>
          </div>
        </div>
      </header>

      {/* ── Main Content Area ── */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 lg:p-6 flex flex-col gap-6">
        {/* Status Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-slate-900/60 border border-slate-800/80 text-xs">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              <span className="text-slate-400">Gemini AI:</span>
              <span className="font-semibold text-slate-200">{config?.textModel || "gemini-3.8-flash"}</span>
            </div>
            <div className="hidden sm:flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-sky-400"></span>
              <span className="text-slate-400">수집 뉴스:</span>
              <span className="font-semibold text-slate-200">{articles.length}개 캐시됨</span>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full ${
                  config?.telegramBotToken ? "bg-emerald-400" : "bg-amber-400"
                }`}
              ></span>
              <span className="text-slate-400">텔레그램 봇:</span>
              <span className="font-semibold text-slate-200">
                {config?.telegramBotToken ? "연동 활성" : "미설정 (설정 탭에서 등록)"}
              </span>
            </div>
            <div className="hidden md:flex items-center gap-2">
              <span className="text-slate-400">인스타 핸들:</span>
              <span className="font-mono text-pink-400">{config?.handle || "@animemag.kr"}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleCollectNews}
              disabled={isCollecting}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
              title="RSS / Reddit / X 최신 뉴스 수집"
            >
              <RefreshCw className={`w-3 h-3 ${isCollecting ? "animate-spin text-sky-400" : ""}`} />
              {isCollecting ? "수집 중..." : "뉴스 새로고침"}
            </button>
          </div>
        </div>

        {/* ── TAB 1: STUDIO (CARD NEWS PRODUCTION & PREVIEW) ── */}
        {activeTab === "studio" && (
          <div className="flex flex-col gap-6">
            {/* If Proposing Topics (Topic Picker View) */}
            {activeJob?.topics && activeJob.topics.length > 0 && !activeJob.slides && (
              <div className="bg-[#0b1020] border border-slate-800 rounded-2xl p-6 shadow-xl">
                <div className="flex items-center justify-between gap-4 mb-4 pb-4 border-b border-slate-800">
                  <div>
                    <h2 className="text-lg font-bold text-white flex items-center gap-2">
                      <Sparkles className="w-5 h-5 text-sky-400" />
                      AI 에디터 추천 토픽 5선
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      최근 48시간 내 공식 발표(PV, 일정, 캐스팅, 투어) 중 인스타그램 독자 반응이 가장 뜨거울 5개 소식입니다.
                    </p>
                  </div>
                  <button
                    onClick={() => handleProposeTopics()}
                    disabled={isProposing}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isProposing ? "animate-spin" : ""}`} />
                    다시 추천받기
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {activeJob.topics.map((t, idx) => {
                    const style = CAT_COLORS[t.cat] || CAT_COLORS.anime;
                    return (
                      <div
                        key={idx}
                        className="bg-slate-900/80 border border-slate-800 hover:border-slate-700 rounded-xl p-5 flex flex-col justify-between transition hover:shadow-lg group"
                      >
                        <div>
                          <div className="flex items-center justify-between gap-2 mb-2">
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${style.bg} ${style.text} ${style.border}`}
                            >
                              {t.cat.toUpperCase()}
                            </span>
                            <span className="text-[11px] text-slate-500 font-mono">
                              #{idx + 1}
                            </span>
                          </div>
                          <h3 className="font-bold text-slate-100 text-sm group-hover:text-sky-300 transition line-clamp-2">
                            {t.title}
                          </h3>
                          <p className="text-xs text-slate-400 mt-2 line-clamp-3 leading-relaxed">
                            {t.angle}
                          </p>
                          <div className="mt-3 pt-3 border-t border-slate-800/80 flex flex-col gap-1 text-[11px]">
                            <div className="text-slate-500">
                              <span className="text-slate-400 font-medium">원제:</span> {t.entity}
                            </div>
                            <div className="text-slate-500 truncate">
                              <span className="text-slate-400 font-medium">출처:</span> {t.sourceName || "공식 채널"}
                            </div>
                          </div>
                        </div>

                        <button
                          onClick={() => handleGenerateJob(t)}
                          disabled={isGenerating}
                          className="mt-4 w-full py-2 px-3 rounded-lg text-xs font-semibold bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 text-white shadow-[0_0_10px_rgba(56,189,248,0.2)] transition flex items-center justify-center gap-1.5"
                        >
                          <Layers className="w-3.5 h-3.5" />
                          이 소식으로 카드뉴스 제작
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* If Generating / In Progress */}
            {isGenerating && (
              <div className="bg-[#0b1020] border border-sky-500/30 rounded-2xl p-10 flex flex-col items-center justify-center text-center shadow-[0_0_30px_rgba(56,189,248,0.15)] animate-pulse">
                <div className="w-16 h-16 rounded-2xl bg-sky-500/20 border border-sky-500/40 flex items-center justify-center mb-4">
                  <Sparkles className="w-8 h-8 text-sky-400 animate-spin" />
                </div>
                <h3 className="text-lg font-bold text-white mb-2">
                  1080x1350 카드뉴스 & 슬라이드 자동 제작 중
                </h3>
                <p className="text-xs text-slate-400 max-w-md leading-relaxed">
                  1. Gemini 원고 작성 → 2. Jikan/Steam/iTunes 공식 API 및 기사 본문 이미지 수집 → 3. dhash 유사 중복 이미지 제거 → 4. Pretendard 폰트 렌더링을 순차 진행하고 있습니다. (약 15~30초 소요)
                </p>
              </div>
            )}

            {/* If Active Job Has Rendered Slides (Review & Editor Studio) */}
            {activeJob && activeJob.renderedSlideDataUrls && activeJob.renderedSlideDataUrls.length > 0 && !isGenerating && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                {/* Left Column: Carousel & Slide Viewer */}
                <div className="lg:col-span-7 flex flex-col gap-4">
                  {/* Slide Info Header */}
                  <div className="bg-[#0b1020] border border-slate-800 rounded-2xl p-4 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <span
                        className={`text-xs font-bold px-2.5 py-1 rounded-full border ${
                          CAT_COLORS[activeJob.topic?.cat || "anime"].bg
                        } ${CAT_COLORS[activeJob.topic?.cat || "anime"].text} ${
                          CAT_COLORS[activeJob.topic?.cat || "anime"].border
                        }`}
                      >
                        {activeJob.topic?.cat.toUpperCase()}
                      </span>
                      <div>
                        <h2 className="text-sm font-bold text-white line-clamp-1">
                          {activeJob.topic?.title}
                        </h2>
                        <span className="text-[11px] text-slate-400">
                          {activeJob.topic?.entity} · {activeJob.slides?.length}장 구성
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <a
                        href={`/api/jobs/${activeJob.id}/download-zip`}
                        download
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition shadow-[0_0_12px_rgba(16,185,129,0.3)]"
                      >
                        <Archive className="w-3.5 h-3.5" />
                        전체 ZIP
                      </a>
                      <button
                        onClick={handleDownloadSingleSlide}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition"
                      >
                        <Download className="w-3.5 h-3.5" />
                        현재 장 저장
                      </button>
                    </div>
                  </div>

                  {/* 1080x1350 Ratio Previewer Card */}
                  <div className="bg-[#0b1020] border border-slate-800 rounded-2xl p-4 flex flex-col items-center justify-center relative group">
                    <div className="relative w-full max-w-[420px] aspect-[4/5] rounded-xl overflow-hidden shadow-2xl border border-slate-800 bg-[#070b14]">
                      <img
                        src={activeJob.renderedSlideDataUrls[selectedSlideIndex]}
                        alt={`Slide ${selectedSlideIndex + 1}`}
                        className="w-full h-full object-contain"
                      />

                      {/* Navigation Overlays */}
                      <button
                        onClick={() =>
                          setSelectedSlideIndex((prev) =>
                            prev > 0 ? prev - 1 : activeJob.renderedSlideDataUrls!.length - 1
                          )
                        }
                        className="absolute left-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/60 hover:bg-black/90 text-white backdrop-blur transition"
                      >
                        <ChevronLeft className="w-5 h-5" />
                      </button>
                      <button
                        onClick={() =>
                          setSelectedSlideIndex((prev) =>
                            prev < activeJob.renderedSlideDataUrls!.length - 1 ? prev + 1 : 0
                          )
                        }
                        className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/60 hover:bg-black/90 text-white backdrop-blur transition"
                      >
                        <ChevronRight className="w-5 h-5" />
                      </button>

                      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-black/70 backdrop-blur text-white text-xs font-mono font-bold">
                        {selectedSlideIndex + 1} / {activeJob.renderedSlideDataUrls.length}
                      </div>
                    </div>

                    {/* Thumbnail Strip */}
                    <div className="flex items-center gap-2 mt-4 overflow-x-auto max-w-full pb-2">
                      {activeJob.renderedSlideDataUrls.map((url, i) => (
                        <button
                          key={i}
                          onClick={() => setSelectedSlideIndex(i)}
                          className={`w-14 aspect-[4/5] rounded-lg overflow-hidden border-2 transition flex-shrink-0 ${
                            selectedSlideIndex === i
                              ? "border-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.5)] scale-105"
                              : "border-slate-800 opacity-60 hover:opacity-100"
                          }`}
                        >
                          <img src={url} alt={`Thumb ${i + 1}`} className="w-full h-full object-cover" />
                        </button>
                      ))}
                    </div>

                    {/* Second Confirmation Action Bar */}
                    <div className="flex flex-wrap items-center justify-center gap-2 mt-4 w-full pt-4 border-t border-slate-800">
                      <button
                        onClick={handleRegenerateImages}
                        disabled={isGenerating}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition"
                      >
                        <ImageIcon className="w-3.5 h-3.5 text-sky-400" />
                        🖼 다른 사진 교체
                      </button>
                      <button
                        onClick={handleRewriteContent}
                        disabled={isGenerating}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition"
                      >
                        <Edit3 className="w-3.5 h-3.5 text-amber-400" />
                        ✏️ 원고 재작성
                      </button>
                      <button
                        onClick={handleSendTelegram}
                        disabled={isSendingTelegram || !config?.telegramBotToken}
                        className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition shadow-[0_0_12px_rgba(56,189,248,0.3)] disabled:opacity-40"
                      >
                        <Send className="w-3.5 h-3.5" />
                        {isSendingTelegram ? "전송 중..." : "📱 텔레그램 앨범 전송"}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Right Column: Slide Editor & Instagram Caption */}
                <div className="lg:col-span-5 flex flex-col gap-5">
                  {/* Inline Slide Text Editor */}
                  <div className="bg-[#0b1020] border border-slate-800 rounded-2xl p-5">
                    <div className="flex items-center justify-between mb-3 pb-3 border-b border-slate-800">
                      <h3 className="text-sm font-bold text-white flex items-center gap-2">
                        <Edit3 className="w-4 h-4 text-sky-400" />
                        슬라이드 #{selectedSlideIndex + 1} 실시간 편집
                      </h3>
                      <span className="text-[11px] text-slate-400 font-mono">
                        {selectedSlideIndex === 0 ? "표지(Hook)" : "본문 슬라이드"}
                      </span>
                    </div>

                    <div className="flex flex-col gap-4">
                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">
                          헤드라인 (제목)
                        </label>
                        <input
                          type="text"
                          value={editHeadline}
                          onChange={(e) => setEditHeadline(e.target.value)}
                          className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-white text-xs focus:outline-none focus:border-sky-500"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-300 mb-1">
                          본문 설명
                        </label>
                        <textarea
                          rows={4}
                          value={editBody}
                          onChange={(e) => setEditBody(e.target.value)}
                          className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-white text-xs focus:outline-none focus:border-sky-500 leading-relaxed"
                        />
                      </div>

                      {activeJob.slides?.[selectedSlideIndex]?.imageQuery && (
                        <div className="bg-slate-900/60 p-2.5 rounded-lg border border-slate-800 text-[11px] text-slate-400 flex items-center justify-between">
                          <span className="font-mono text-sky-300">
                            🔍 검색어: {activeJob.slides[selectedSlideIndex].imageQuery}
                          </span>
                        </div>
                      )}

                      <button
                        onClick={handleUpdateSlide}
                        disabled={isUpdatingSlide}
                        className="w-full py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-white text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-[0_0_12px_rgba(56,189,248,0.3)] disabled:opacity-50"
                      >
                        <Check className="w-4 h-4" />
                        {isUpdatingSlide ? "슬라이드 렌더링 중..." : "적용 및 즉시 재렌더링"}
                      </button>
                    </div>
                  </div>

                  {/* Instagram Caption Box */}
                  <div className="bg-[#0b1020] border border-slate-800 rounded-2xl p-5 flex flex-col flex-1">
                    <div className="flex items-center justify-between mb-3 pb-3 border-b border-slate-800">
                      <h3 className="text-sm font-bold text-white flex items-center gap-2">
                        <FileText className="w-4 h-4 text-pink-400" />
                        인스타그램 본문 캡션
                      </h3>
                      <button
                        onClick={handleCopyCaption}
                        className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 transition"
                      >
                        {copiedCaption ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                            <span className="text-emerald-400">복사됨!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>캡션 복사</span>
                          </>
                        )}
                      </button>
                    </div>

                    <div className="relative flex-1">
                      <textarea
                        readOnly
                        value={activeJob.caption || ""}
                        rows={10}
                        className="w-full h-full p-3 rounded-xl bg-slate-950/80 border border-slate-800 text-slate-300 text-xs leading-relaxed font-sans resize-none focus:outline-none"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Empty State / Welcome */}
            {!activeJob && !isProposing && !isGenerating && (
              <div className="bg-[#0b1020] border border-slate-800 rounded-2xl p-10 text-center flex flex-col items-center justify-center max-w-2xl mx-auto shadow-2xl my-6">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-sky-500/20 to-pink-500/20 border border-slate-700 flex items-center justify-center mb-4">
                  <Flame className="w-8 h-8 text-sky-400" />
                </div>
                <h2 className="text-xl font-extrabold text-white mb-2">
                  서브컬처 자동 매거진 제작 봇 스튜디오
                </h2>
                <p className="text-xs text-slate-400 max-w-md leading-relaxed mb-6">
                  애니메이션·게임·JPOP 공식 소식을 수집하고, Gemini가 독자가 열광할 앵글로 카드뉴스를 기획합니다. Jikan·Steam·iTunes 고화질 이미지와 Pretendard 폰트로 1080x1350 카드뉴스를 즉시 완성하세요.
                </p>

                <div className="flex flex-col sm:flex-row items-center gap-3 w-full justify-center">
                  <button
                    onClick={() => handleProposeTopics()}
                    className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 text-white font-bold text-xs shadow-[0_0_20px_rgba(56,189,248,0.4)] transition flex items-center justify-center gap-2"
                  >
                    <Sparkles className="w-4 h-4" />
                    AI 5선 토픽 추천받기
                  </button>
                  <button
                    onClick={() => setActiveTab("radar")}
                    className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs border border-slate-700 transition flex items-center justify-center gap-2"
                  >
                    <Radio className="w-4 h-4 text-sky-400" />
                    수집된 뉴스 레이더 보기 ({articles.length}건)
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── TAB 2: NEWS RADAR (ARTICLE FEED) ── */}
        {activeTab === "radar" && (
          <div className="flex flex-col gap-5">
            {/* Filter Bar */}
            <div className="bg-[#0b1020] border border-slate-800 rounded-2xl p-4 flex flex-col md:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => setSelectedCatFilter("all")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    selectedCatFilter === "all"
                      ? "bg-sky-500 text-white"
                      : "bg-slate-900 text-slate-400 hover:text-white border border-slate-800"
                  }`}
                >
                  전체 ({articles.length})
                </button>
                <button
                  onClick={() => setSelectedCatFilter("anime")}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    selectedCatFilter === "anime"
                      ? "bg-sky-500 text-white"
                      : "bg-slate-900 text-slate-400 hover:text-white border border-slate-800"
                  }`}
                >
                  <Tv className="w-3.5 h-3.5" />
                  애니메이션
                </button>
                <button
                  onClick={() => setSelectedCatFilter("game")}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    selectedCatFilter === "game"
                      ? "bg-lime-500 text-black font-bold"
                      : "bg-slate-900 text-slate-400 hover:text-white border border-slate-800"
                  }`}
                >
                  <Gamepad2 className="w-3.5 h-3.5" />
                  게임
                </button>
                <button
                  onClick={() => setSelectedCatFilter("jpop")}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    selectedCatFilter === "jpop"
                      ? "bg-pink-500 text-white font-bold"
                      : "bg-slate-900 text-slate-400 hover:text-white border border-slate-800"
                  }`}
                >
                  <Music className="w-3.5 h-3.5" />
                  J-POP
                </button>
                <button
                  onClick={() => setSelectedCatFilter("reddit")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    selectedCatFilter === "reddit"
                      ? "bg-orange-500 text-white"
                      : "bg-slate-900 text-slate-400 hover:text-white border border-slate-800"
                  }`}
                >
                  Reddit 커뮤니티
                </button>
                <button
                  onClick={() => setSelectedCatFilter("x")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    selectedCatFilter === "x"
                      ? "bg-slate-100 text-black font-bold"
                      : "bg-slate-900 text-slate-400 hover:text-white border border-slate-800"
                  }`}
                >
                  X 실시간 트렌드
                </button>
              </div>

              <div className="flex items-center gap-3 w-full md:w-auto">
                {/* 한국어 번역 토글 버튼 */}
                <button
                  type="button"
                  onClick={() => setShowKorean((prev) => !prev)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition border ${
                    showKorean
                      ? "bg-indigo-500/20 text-indigo-300 border-indigo-500/40 shadow-[0_0_10px_rgba(99,102,241,0.25)]"
                      : "bg-slate-900 text-slate-400 border-slate-800 hover:text-white"
                  }`}
                >
                  <span>{showKorean ? "🇰🇷 한국어 번역 ON" : "🌐 원문 표시"}</span>
                </button>

                <div className="w-full md:w-56">
                  <input
                    type="text"
                    placeholder="한국어/원문 키워드 검색..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>
            </div>

            {/* Articles Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredArticles.map((art, idx) => {
                const style = CAT_COLORS[art.cat] || CAT_COLORS.anime;
                const thumb = art.images?.[0];
                const displayTitle = showKorean && art.titleKo ? art.titleKo : art.title;
                const displaySnippet = showKorean && art.snippetKo ? art.snippetKo : art.snippet;
                const hasTranslation = Boolean(art.titleKo && art.titleKo !== art.title);

                return (
                  <div
                    key={idx}
                    className="bg-[#0b1020] border border-slate-800 hover:border-slate-700 rounded-xl overflow-hidden flex flex-col justify-between transition group shadow-md"
                  >
                    <div>
                      {thumb && (
                        <div className="w-full h-36 bg-slate-950 overflow-hidden relative">
                          <img
                            src={thumb}
                            alt=""
                            className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                            onError={(e) => {
                              (e.target as HTMLElement).style.display = "none";
                            }}
                          />
                          <div className="absolute top-2 left-2 flex items-center gap-1">
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded-full border backdrop-blur ${style.bg} ${style.text} ${style.border}`}
                            >
                              {art.cat.toUpperCase()}
                            </span>
                            {hasTranslation && showKorean && (
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-indigo-900/80 text-indigo-300 border border-indigo-700/60 backdrop-blur">
                                🇰🇷 번역
                              </span>
                            )}
                          </div>
                        </div>
                      )}

                      <div className="p-4">
                        {!thumb && (
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-1">
                              <span
                                className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${style.bg} ${style.text} ${style.border}`}
                              >
                                {art.cat.toUpperCase()}
                              </span>
                              {hasTranslation && showKorean && (
                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-indigo-900/80 text-indigo-300 border border-indigo-700/60">
                                  🇰🇷 번역
                                </span>
                              )}
                            </div>
                            <span className="text-[11px] text-slate-500">
                              {new Date(art.date).toLocaleDateString("ko-KR")}
                            </span>
                          </div>
                        )}

                        <h3 className="font-bold text-slate-100 text-xs line-clamp-2 group-hover:text-sky-300 transition leading-snug">
                          {displayTitle}
                        </h3>

                        {hasTranslation && showKorean && (
                          <p className="text-[10px] text-slate-500 mt-1 line-clamp-1 italic font-sans">
                            원문: {art.title}
                          </p>
                        )}

                        <p className="text-[11px] text-slate-400 mt-2 line-clamp-3 leading-relaxed">
                          {displaySnippet || "상세 본문 요약 내용이 없습니다."}
                        </p>

                        <div className="mt-3 flex items-center justify-between text-[11px] text-slate-500">
                          <span className="truncate max-w-[140px]">{art.source}</span>
                          {art.score && (
                            <span className="text-orange-400 font-semibold font-mono">
                              ▲ {art.score}
                            </span>
                          )}
                          <div className="flex items-center gap-2">
                            {(!hasTranslation || art.titleKo === art.title) && (
                              <button
                                type="button"
                                onClick={() => handleTranslateArticle(art)}
                                disabled={translatingLinks.has(art.link)}
                                className="text-indigo-400 hover:text-indigo-300 text-[11px] font-semibold flex items-center gap-1 hover:underline disabled:opacity-50"
                                title="이 기사를 한국어로 번역합니다"
                              >
                                <Languages className={`w-3 h-3 ${translatingLinks.has(art.link) ? "animate-spin" : ""}`} />
                                {translatingLinks.has(art.link) ? "번역 중..." : "한국어 번역"}
                              </button>
                            )}
                            <a
                              href={art.link}
                              target="_blank"
                              rel="noreferrer"
                              className="text-slate-400 hover:text-white flex items-center gap-0.5"
                            >
                              원문 <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="p-4 pt-0">
                      <button
                        onClick={() =>
                          handleGenerateJob({
                            idx,
                            title: displayTitle,
                            angle: displaySnippet,
                            why: "뉴스 피드 직접 선택",
                            cat: art.cat,
                            entity: (art.title || "").split(/[:\-–—|]/)[0].trim() || art.title,
                            sourceName: art.source,
                            sourceUrl: art.link,
                            articleImages: art.images,
                          })
                        }
                        className="w-full py-1.5 rounded-lg bg-slate-800 hover:bg-sky-600 text-slate-300 hover:text-white text-xs font-semibold border border-slate-700 hover:border-transparent transition flex items-center justify-center gap-1"
                      >
                        <Layers className="w-3 h-3" />
                        이 소식으로 카드뉴스 제작
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── TAB 3: HISTORY ── */}
        {activeTab === "history" && (
          <div className="bg-[#0b1020] border border-slate-800 rounded-2xl p-6">
            <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
              <Archive className="w-5 h-5 text-sky-400" />
              카드뉴스 제작 히스토리 ({jobs.length}건)
            </h2>

            {jobs.length === 0 ? (
              <p className="text-xs text-slate-500 py-8 text-center">
                아직 제작된 카드뉴스가 없습니다. AI 5선 토픽 추천이나 뉴스 레이더에서 제작을 시작해 보세요!
              </p>
            ) : (
              <div className="divide-y divide-slate-800">
                {jobs.map((j) => (
                  <div key={j.id} className="py-4 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                          CAT_COLORS[j.cat as Cat]?.bg || CAT_COLORS.anime.bg
                        } ${CAT_COLORS[j.cat as Cat]?.text || CAT_COLORS.anime.text} ${
                          CAT_COLORS[j.cat as Cat]?.border || CAT_COLORS.anime.border
                        }`}
                      >
                        {String(j.cat || "ANIME").toUpperCase()}
                      </span>
                      <div>
                        <h4 className="text-xs font-bold text-white">{j.title}</h4>
                        <span className="text-[11px] text-slate-500">
                          {new Date(j.createdAt).toLocaleString("ko-KR")} · 슬라이드 {j.slideCount}장
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={async () => {
                          const res = await fetch(`/api/jobs/${j.id}`);
                          if (res.ok) {
                            const d = await res.json();
                            setActiveJob(d.job);
                            setActiveTab("studio");
                          }
                        }}
                        className="px-3 py-1.5 rounded-lg bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 border border-sky-500/30 text-xs font-semibold transition flex items-center gap-1"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        스튜디오에서 보기
                      </button>
                      <a
                        href={`/api/jobs/${j.id}/download-zip`}
                        download
                        className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                        title="ZIP 다운로드"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── TAB 4: SETTINGS & TELEGRAM & ACTIVITY LOGS ── */}
        {activeTab === "settings" && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Left Column: Telegram & Model Settings */}
            <div className="lg:col-span-6 bg-[#0b1020] border border-slate-800 rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800">
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <Send className="w-4 h-4 text-sky-400" />
                  텔레그램 봇 연동 설정
                </h2>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/30 font-medium">
                  API 키 + Chat ID만 사용
                </span>
              </div>

              {/* 30초 연동 가이드 */}
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 mb-5 text-xs text-slate-300">
                <div className="font-bold text-sky-300 mb-1.5 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" /> 30초 초간단 연동 방법
                </div>
                <ol className="list-decimal list-inside space-y-1 text-[11px] text-slate-400 leading-relaxed">
                  <li>
                    텔레그램 검색창에서 <span className="font-mono text-white">@BotFather</span> 검색 후 대화 시작 → <span className="font-mono text-sky-300">/newbot</span> 입력하여 봇 생성 후 <b>봇 토큰(API 키)</b> 발급
                  </li>
                  <li>
                    텔레그램 검색창에서 <span className="font-mono text-white">@userinfobot</span> 검색 후 시작 → 표시되는 본인의 숫자 <span className="font-mono text-sky-300">Id</span> 확인
                  </li>
                  <li>
                    아래 두 입력창에 넣고 <b>[연동 테스트 전송]</b> 버튼을 누르면 연동 완료!
                  </li>
                </ol>
              </div>

              {config && (
                <form onSubmit={handleSaveConfig} className="flex flex-col gap-4 text-xs">
                  <div>
                    <label className="block text-slate-200 font-semibold mb-1">
                      1. 텔레그램 봇 토큰 (API 키) *
                    </label>
                    <input
                      type="password"
                      required
                      placeholder="예: 7123456789:AAHk..."
                      value={config.telegramBotToken}
                      onChange={(e) => setConfig({ ...config, telegramBotToken: e.target.value })}
                      className="w-full px-3 py-2.5 rounded-lg bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-sky-500 font-mono text-xs"
                    />
                    <p className="text-[11px] text-slate-500 mt-1">
                      @BotFather에서 발급받은 Telegram Bot Token API 키입니다.
                    </p>
                  </div>

                  <div>
                    <label className="block text-slate-200 font-semibold mb-1">
                      2. 텔레그램 Chat ID (채팅/사용자 ID) *
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="예: 987654321"
                      value={config.telegramChatId}
                      onChange={(e) => setConfig({ ...config, telegramChatId: e.target.value })}
                      className="w-full px-3 py-2.5 rounded-lg bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-sky-500 font-mono text-xs"
                    />
                    <p className="text-[11px] text-slate-500 mt-1">
                      알림을 수신할 본인의 텔레그램 개인 ID 또는 단체 채팅방 ID입니다.
                    </p>
                  </div>

                  <div className="pt-2 border-t border-slate-800">
                    <label className="block text-slate-300 font-semibold mb-1">
                      인스타그램 매거진 워터마크 핸들
                    </label>
                    <input
                      type="text"
                      value={config.handle}
                      onChange={(e) => setConfig({ ...config, handle: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-sky-500 font-mono text-xs"
                    />
                    <p className="text-[11px] text-slate-500 mt-1">
                      카드뉴스 우측 하단에 들어갈 계정명 (예: @animemag.kr)
                    </p>
                  </div>

                  <div className="flex flex-col sm:flex-row items-center gap-2.5 pt-2">
                    <button
                      type="submit"
                      className="w-full sm:flex-1 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold border border-slate-700 transition"
                    >
                      설정 저장
                    </button>
                    <button
                      type="button"
                      onClick={handleTestTelegramConnection}
                      disabled={isTestingTelegram || !config.telegramBotToken || !config.telegramChatId}
                      className="w-full sm:flex-1 py-2.5 rounded-lg bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 text-white font-bold transition shadow-[0_0_15px_rgba(56,189,248,0.3)] disabled:opacity-40 flex items-center justify-center gap-1.5"
                    >
                      <Send className={`w-3.5 h-3.5 ${isTestingTelegram ? "animate-spin" : ""}`} />
                      {isTestingTelegram ? "전송 중..." : "📱 연동 테스트 전송"}
                    </button>
                  </div>
                </form>
              )}
            </div>

            {/* Right Column: Cloud Scheduler Guide & Activity Logs */}
            <div className="lg:col-span-6 flex flex-col gap-5">
              {/* Cloud Scheduler Guide */}
              <div className="bg-[#0b1020] border border-slate-800 rounded-2xl p-5 text-xs">
                <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-emerald-400" />
                  Cloud Scheduler 매일 자동 실행 설정법
                </h3>
                <p className="text-slate-400 leading-relaxed mb-3">
                  Google Cloud Scheduler로 매일 아침 자동으로 뉴스를 수집하고 텔레그램으로 1차 컨펌을 받으려면 아래 URL로 HTTP GET 작업을 등록하세요:
                </p>
                <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800 font-mono text-[11px] text-emerald-400 break-all select-all">
                  {config?.publicBaseUrl}/cron?key={config?.cronSecret}
                </div>
              </div>

              {/* Real-time Logs Console */}
              <div className="bg-[#0b1020] border border-slate-800 rounded-2xl p-5 flex flex-col flex-1">
                <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-800">
                  <h3 className="text-xs font-bold text-white flex items-center gap-1.5 font-mono">
                    <Terminal className="w-3.5 h-3.5 text-sky-400" />
                    LIVE SERVER ACTIVITY LOGS
                  </h3>
                  <button
                    onClick={fetchLogs}
                    className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition"
                    title="로그 새로고침"
                  >
                    <RefreshCw className="w-3 h-3" />
                  </button>
                </div>

                <div className="bg-slate-950 rounded-xl p-3 h-64 overflow-y-auto font-mono text-[11px] flex flex-col gap-1 border border-slate-900">
                  {logs.map((log) => {
                    const color =
                      log.level === "error"
                        ? "text-red-400"
                        : log.level === "warn"
                        ? "text-amber-400"
                        : log.level === "success"
                        ? "text-emerald-400"
                        : "text-slate-400";
                    return (
                      <div key={log.id} className="leading-tight flex items-start gap-2">
                        <span className="text-slate-600 flex-shrink-0">[{log.time}]</span>
                        <span className={`font-semibold uppercase text-[9px] px-1 py-0.2 rounded bg-slate-900 flex-shrink-0 ${color}`}>
                          {log.level}
                        </span>
                        <span className="text-slate-300 break-words">{log.message}</span>
                      </div>
                    );
                  })}
                  <div ref={logsEndRef} />
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ── Custom Topic Modal ── */}
      {showCustomModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0b1020] border border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl">
            <h3 className="text-base font-bold text-white mb-2 flex items-center gap-2">
              <PlusCircle className="w-5 h-5 text-sky-400" />
              직접 기획 카드뉴스 제작
            </h3>
            <p className="text-xs text-slate-400 mb-4">
              수집된 기사 외에 원하는 애니, 게임, J-POP 소식의 정보를 직접 입력하여 맞춤형 카드뉴스를 제작합니다.
            </p>

            <form onSubmit={handleCustomGenerate} className="flex flex-col gap-3 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  카테고리
                </label>
                <select
                  value={customForm.cat}
                  onChange={(e) => setCustomForm({ ...customForm, cat: e.target.value as Cat })}
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-sky-500"
                >
                  <option value="anime">애니메이션 (ANIME)</option>
                  <option value="game">게임 (GAME)</option>
                  <option value="jpop">J-POP (J-POP)</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  기사/카드뉴스 제목 *
                </label>
                <input
                  type="text"
                  required
                  placeholder="예: 장송의 프리렌 2기 제작 공식 확정!"
                  value={customForm.title}
                  onChange={(e) => setCustomForm({ ...customForm, title: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  작품 공식 원제 (영문/일문) *
                </label>
                <input
                  type="text"
                  required
                  placeholder="예: Sousou no Frieren (Jikan/MAL/Steam 이미지 검색용)"
                  value={customForm.entity}
                  onChange={(e) => setCustomForm({ ...customForm, entity: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-sky-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  기획 포인트 및 본문 요약 내용
                </label>
                <textarea
                  rows={3}
                  placeholder="공식 PV 공개 일정, 방영 시기, 성우진 및 제작사 정보 등..."
                  value={customForm.angle}
                  onChange={(e) => setCustomForm({ ...customForm, angle: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  대표 이미지 URL (선택)
                </label>
                <input
                  type="url"
                  placeholder="https://... (없으면 공식 API로 자동 탐색)"
                  value={customForm.imageUrl}
                  onChange={(e) => setCustomForm({ ...customForm, imageUrl: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-sky-500 font-mono"
                />
              </div>

              <div className="flex items-center justify-end gap-2 mt-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowCustomModal(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                >
                  취소
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-white font-bold transition shadow-[0_0_12px_rgba(56,189,248,0.3)]"
                >
                  카드뉴스 제작 시작
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
