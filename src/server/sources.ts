import type { Source } from "./types.js";

export const SOURCES: Source[] = [
  // 애니
  { kind: "rss", name: "Anime News Network", url: "https://www.animenewsnetwork.com/all/rss.xml", cat: "anime" },
  { kind: "rss", name: "Anime Corner", url: "https://animecorner.me/feed/", cat: "anime" },
  { kind: "rss", name: "MyAnimeList", url: "https://myanimelist.net/rss/news.xml", cat: "anime" },
  { kind: "rss", name: "コミックナタリー", url: "https://natalie.mu/comic/feed/news", cat: "anime" },

  // 게임
  { kind: "rss", name: "Gematsu", url: "https://www.gematsu.com/feed", cat: "game" },
  { kind: "rss", name: "AUTOMATON", url: "https://automaton-media.com/en/feed/", cat: "game" },
  { kind: "rss", name: "Siliconera", url: "https://www.siliconera.com/feed/", cat: "game" },
  { kind: "rss", name: "Game Spark", url: "https://www.gamespark.jp/rss/index.rdf", cat: "game" },

  // JPOP
  { kind: "rss", name: "音楽ナタリー", url: "https://natalie.mu/music/feed/news", cat: "jpop" },
  { kind: "rss", name: "ARAMA! JAPAN", url: "https://aramajapan.com/feed/", cat: "jpop" },

  // 해외 커뮤니티
  { kind: "reddit", name: "r/anime", sub: "anime", cat: "anime" },
  { kind: "reddit", name: "r/gachagaming", sub: "gachagaming", cat: "game" },
  { kind: "reddit", name: "r/JRPG", sub: "JRPG", cat: "game" },
  { kind: "reddit", name: "r/jpop", sub: "jpop", cat: "jpop" },
];
