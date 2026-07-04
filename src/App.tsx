import React, { useState, useEffect, useRef } from "react";
import {
  Upload,
  BookOpen,
  Volume2,
  VolumeX,
  Play,
  Pause,
  SkipForward,
  SkipBack,
  Square,
  ChevronRight,
  ChevronLeft,
  Sliders,
  Maximize2,
  RefreshCw,
  Clock,
  Mic,
  AlertCircle,
  Library,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Book, Chapter, Paragraph, ReaderTheme } from "./types";
import { parseEpubBuffer } from "./epubParser";

const EMPTY_BOOK: Book = { title: "", creator: "", chapters: [] };

// ─── Types ───────────────────────────────────────────────────────────────────
interface VoiceInfo {
  label: string;
  model: string;
  downloaded: boolean;
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  // Sách
  const [currentBook, setCurrentBook] = useState<Book>(EMPTY_BOOK);
  const [uploadedBook, setUploadedBook] = useState<Book | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parseProgress, setParseProgress] = useState(0);
  const [parseError, setParseError] = useState<string | null>(null);

  // Đọc sách
  const [activeChapterIndex, setActiveChapterIndex] = useState(0);
  const [activeParagraphIndex, setActiveParagraphIndex] = useState<number | null>(null);

  // Playback
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [ttsVoice, setTtsVoice] = useState("nghitts:ngochuyennew");
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [currentSampleRate, setCurrentSampleRate] = useState(22050);

  // Voices từ server
  const [voices, setVoices] = useState<Record<string, VoiceInfo>>({});
  const [voicesLoaded, setVoicesLoaded] = useState(false);

  // Giao diện
  const [readerTheme, setReaderTheme] = useState<ReaderTheme>("sepia");
  const [fontFamily, setFontFamily] = useState<"serif" | "sans" | "mono">("serif");
  const [fontSize, setFontSize] = useState<"sm" | "md" | "lg" | "xl">("md");
  const [showSettings, setShowSettings] = useState(false);

  // Audio refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const activeSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const isPlayingRef = useRef(false);
  const currentParagraphIndexRef = useRef<number | null>(null);
  const audioStartTimestampRef = useRef<number>(0);
  const elapsedOffsetRef = useRef<number>(0);
  const currentAudioBufferRef = useRef<AudioBuffer | null>(null);
  const paragraphsContainerRef = useRef<HTMLDivElement>(null);

  // ── Hàng đợi phát trước (prefetch queue) ────────────────────────────────────
  // Cache dữ liệu âm thanh (base64 PCM) đã tải trước, key = "chapterIdx:paragraphIdx"
  const audioCacheRef = useRef<Map<string, { audio: string; sampleRate: number }>>(new Map());
  // Các request đang bay (chưa xong) để tránh gửi trùng request cho cùng 1 đoạn
  const prefetchPromisesRef = useRef<Map<string, Promise<{ audio: string; sampleRate: number } | undefined>>>(new Map());

  isPlayingRef.current = isPlaying;
  currentParagraphIndexRef.current = activeParagraphIndex;

  // Load danh sách giọng từ server
  useEffect(() => {
    fetch("/api/voices")
      .then((r) => r.json())
      .then((data) => {
        const voicesData = data as Record<string, VoiceInfo>;
        setVoices(voicesData);
        setVoicesLoaded(true);

        const DEFAULT_VOICE_KEY = "nghitts:ngochuyennew";
        if (voicesData[DEFAULT_VOICE_KEY]?.downloaded) {
          // Giọng mặc định mong muốn đã có sẵn -> dùng luôn, không cần chọn giọng khác.
          setTtsVoice(DEFAULT_VOICE_KEY);
          return;
        }

        // Giọng mặc định chưa có -> quay về logic chọn tự động như cũ.
        const downloaded = Object.entries(voicesData).find(([, v]) => v.downloaded);
        if (downloaded) setTtsVoice(downloaded[0]);
        // Auto-select first piper voice if available
        const firstPiper = Object.entries(voicesData).find(
          ([k, v]) => k.startsWith("piper:") && v.downloaded
        );
        if (firstPiper) setTtsVoice(firstPiper[0]);
      })
      .catch(() => {
        setVoicesLoaded(true); // server chưa chạy / lỗi network
      });
  }, []);

  useEffect(() => {
    return () => {
      stopAudioInternal();
      audioCtxRef.current?.close().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (activeSourceRef.current && isPlaying) {
      try {
        activeSourceRef.current.playbackRate.value = playbackSpeed;
      } catch {}
    }
  }, [playbackSpeed, isPlaying]);

  // ── Audio helpers ──────────────────────────────────────────────────────────
  const stopAudioInternal = () => {
    if (activeSourceRef.current) {
      try { activeSourceRef.current.stop(); } catch {}
      activeSourceRef.current = null;
    }
    setIsLoadingAudio(false);
  };

  const isCurrentlyActiveSource = (src: AudioBufferSourceNode) =>
    activeSourceRef.current === src;

  const playBufferDirectly = (buffer: AudioBuffer, startOffset: number, pIndex: number) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = playbackSpeed;
    source.connect(ctx.destination);
    source.onended = () => {
      if (isPlayingRef.current && isCurrentlyActiveSource(source)) {
        handleParagraphEnded();
      }
    };
    activeSourceRef.current = source;
    audioStartTimestampRef.current = ctx.currentTime - startOffset / playbackSpeed;
    elapsedOffsetRef.current = startOffset;
    source.start(0, startOffset);
    setIsLoadingAudio(false);
    setIsPlaying(true);
    // Dùng pIndex truyền vào trực tiếp (không phụ thuộc state React) để đảm bảo
    // luôn cuộn đúng đoạn đang phát vào giữa màn hình, kể cả khi tự động
    // chuyển sang đoạn kế tiếp ngay sau khi phát xong đoạn trước.
    setTimeout(() => scrollParagraphIntoView(pIndex), 100);
  };

  const playPCMData = async (
    base64Str: string,
    pIndex: number,
    startOffset: number,
    sampleRate: number
  ) => {
    try {
      const binary = atob(base64Str);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const numSamples = binary.length / 2;
      const floatData = new Float32Array(numSamples);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < numSamples; i++) {
        floatData[i] = view.getInt16(i * 2, true) / 32768.0;
      }

      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext ||
          (window as any).webkitAudioContext)({ sampleRate });
      } else if (audioCtxRef.current.sampleRate !== sampleRate) {
        await audioCtxRef.current.close();
        audioCtxRef.current = new (window.AudioContext ||
          (window as any).webkitAudioContext)({ sampleRate });
      }

      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") await ctx.resume();

      const buffer = ctx.createBuffer(1, numSamples, sampleRate);
      buffer.getChannelData(0).set(floatData);
      currentAudioBufferRef.current = buffer;
      playBufferDirectly(buffer, startOffset, pIndex);
    } catch (e) {
      setAudioError("Lỗi giải mã dữ liệu âm thanh.");
      setIsPlaying(false);
      setIsLoadingAudio(false);
    }
  };

  // ── Prefetch helpers ──────────────────────────────────────────────────────
  const paragraphKey = (chapterIdx: number, pIdx: number) => `${chapterIdx}:${pIdx}`;

  const clearAudioQueue = () => {
    audioCacheRef.current.clear();
    prefetchPromisesRef.current.clear();
  };

  // Bỏ các entry trong cache không còn cần thiết (đã phát qua / quá xa hàng đợi)
  const pruneAudioQueue = (chapterIdx: number, pIdx: number) => {
    const keep = new Set<string>([paragraphKey(chapterIdx, pIdx)]);
    const nextRef = getNextParagraphRef(chapterIdx, pIdx);
    if (nextRef) keep.add(paragraphKey(nextRef.chapterIdx, nextRef.pIdx));
    Array.from(audioCacheRef.current.keys()).forEach((key: string) => {
      if (!keep.has(key)) audioCacheRef.current.delete(key);
    });
  };

  // Xác định đoạn văn kế tiếp (tự động sang chương sau nếu hết đoạn của chương hiện tại)
  const getNextParagraphRef = (
    chapterIdx: number,
    pIdx: number
  ): { chapterIdx: number; pIdx: number } | null => {
    const chapter = currentBook.chapters[chapterIdx];
    if (!chapter) return null;
    if (pIdx < chapter.paragraphs.length) return { chapterIdx, pIdx };
    const nextChapter = currentBook.chapters[chapterIdx + 1];
    if (nextChapter && nextChapter.paragraphs.length > 0) {
      return { chapterIdx: chapterIdx + 1, pIdx: 0 };
    }
    return null;
  };

  // Gọi thẳng /api/tts, tách riêng để dùng chung cho phát trực tiếp và prefetch
  const fetchTTSData = async (
    text: string,
    engine: string,
    voiceKey: string,
    speed: number
  ): Promise<{ audio: string; sampleRate: number }> => {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, engine, voice: voiceKey, speed }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "Lỗi khi gọi TTS server.");
    }

    const data = await res.json();
    if (!data.audio) throw new Error("Server không trả về dữ liệu âm thanh.");
    return { audio: data.audio as string, sampleRate: (data.sampleRate ?? 22050) as number };
  };

  // Gửi request tạo âm thanh cho 1 đoạn văn trước, kết quả lưu vào audioCacheRef.
  // Không throw lỗi ra ngoài (lỗi sẽ được thử lại khi thực sự cần phát đoạn đó).
  const prefetchParagraph = (chapterIdx: number, pIdx: number) => {
    const chapter = currentBook.chapters[chapterIdx];
    const paragraph = chapter?.paragraphs[pIdx];
    if (!paragraph) return;

    const key = paragraphKey(chapterIdx, pIdx);
    if (audioCacheRef.current.has(key) || prefetchPromisesRef.current.has(key)) return;

    const [engine, voiceKey] = ttsVoice.includes(":")
      ? (ttsVoice.split(":") as [string, string])
      : ["piper", ttsVoice];

    const promise = fetchTTSData(paragraph.text, engine, voiceKey, playbackSpeed)
      .then((result) => {
        audioCacheRef.current.set(key, result);
        prefetchPromisesRef.current.delete(key);
        return result;
      })
      .catch(() => {
        // Im lặng bỏ qua – nếu đoạn này thực sự được phát, playParagraphAudio
        // sẽ tự gửi lại request và hiển thị lỗi (nếu có) lúc đó.
        prefetchPromisesRef.current.delete(key);
        return undefined;
      });

    prefetchPromisesRef.current.set(key, promise);
  };

  const playParagraphAudio = async (pIndex: number, startOffset = 0) => {
    const chapter = currentBook.chapters[activeChapterIndex];
    if (!chapter?.paragraphs[pIndex]) return;

    const paragraph = chapter.paragraphs[pIndex];
    stopAudioInternal();
    setActiveParagraphIndex(pIndex);
    setAudioError(null);

    // Dùng buffer cache khi resume
    if (
      currentAudioBufferRef.current &&
      currentParagraphIndexRef.current === pIndex &&
      startOffset > 0
    ) {
      playBufferDirectly(currentAudioBufferRef.current, startOffset, pIndex);
      return;
    }

    setIsLoadingAudio(true);
    setIsPlaying(true);

    const cacheKey = paragraphKey(activeChapterIndex, pIndex);
    const [engine, voiceKey] = ttsVoice.includes(":")
      ? (ttsVoice.split(":") as [string, string])
      : ["piper", ttsVoice];

    try {
      // Ưu tiên lấy từ cache (đã được xếp hàng tải trước) hoặc request đang bay,
      // chỉ gửi request mới nếu chưa có sẵn (ví dụ người dùng bấm nhảy đoạn xa).
      let result = audioCacheRef.current.get(cacheKey);
      if (result) {
        audioCacheRef.current.delete(cacheKey);
      } else {
        const pending = prefetchPromisesRef.current.get(cacheKey);
        result = pending
          ? await pending
          : await fetchTTSData(paragraph.text, engine, voiceKey, playbackSpeed);
        prefetchPromisesRef.current.delete(cacheKey);
      }

      if (!result) {
        // Prefetch trước đó lỗi -> thử lại trực tiếp 1 lần nữa
        result = await fetchTTSData(paragraph.text, engine, voiceKey, playbackSpeed);
      }

      setCurrentSampleRate(result.sampleRate);

      // Ngay khi vừa nhận xong dữ liệu âm thanh của đoạn hiện tại (chưa cần chờ
      // phát xong), lập tức gửi request xếp hàng cho đoạn kế tiếp để tạo luồng
      // phát liên tục không có độ trễ giữa các đoạn.
      const nextRef = getNextParagraphRef(activeChapterIndex, pIndex + 1);
      if (nextRef) prefetchParagraph(nextRef.chapterIdx, nextRef.pIdx);
      pruneAudioQueue(activeChapterIndex, pIndex);

      await playPCMData(result.audio, pIndex, startOffset, result.sampleRate);
    } catch (err: any) {
      setAudioError(err.message || "Không thể phát âm thanh.");
      setIsPlaying(false);
      setIsLoadingAudio(false);
    }
  };

  const handleParagraphEnded = () => {
    const chapter = currentBook.chapters[activeChapterIndex];
    if (!chapter) return;
    const cur = currentParagraphIndexRef.current;
    if (cur !== null && cur < chapter.paragraphs.length - 1) {
      currentAudioBufferRef.current = null;
      elapsedOffsetRef.current = 0;
      playParagraphAudio(cur + 1);
    } else {
      setIsPlaying(false);
      setActiveParagraphIndex(null);
      elapsedOffsetRef.current = 0;
      currentAudioBufferRef.current = null;
    }
  };

  const togglePlayPause = () => {
    if (activeParagraphIndex === null) { playParagraphAudio(0); return; }
    if (isPlaying) {
      if (audioCtxRef.current && activeSourceRef.current) {
        const elapsed =
          (audioCtxRef.current.currentTime - audioStartTimestampRef.current) *
          playbackSpeed;
        elapsedOffsetRef.current = Math.min(
          elapsed,
          currentAudioBufferRef.current?.duration ?? 0
        );
      }
      stopAudioInternal();
      setIsPlaying(false);
    } else {
      playParagraphAudio(activeParagraphIndex, elapsedOffsetRef.current);
    }
  };

  const handleStop = () => {
    stopAudioInternal();
    setIsPlaying(false);
    setActiveParagraphIndex(null);
    elapsedOffsetRef.current = 0;
    currentAudioBufferRef.current = null;
    clearAudioQueue();
  };

  const handleNext = () => {
    const chapter = currentBook.chapters[activeChapterIndex];
    if (!chapter) return;
    if (activeParagraphIndex === null) { playParagraphAudio(0); return; }
    currentAudioBufferRef.current = null;
    elapsedOffsetRef.current = 0;
    if (activeParagraphIndex < chapter.paragraphs.length - 1) {
      playParagraphAudio(activeParagraphIndex + 1);
    } else if (activeChapterIndex < currentBook.chapters.length - 1) {
      setActiveChapterIndex((p) => p + 1);
      setActiveParagraphIndex(null);
      if (isPlaying) setTimeout(() => playParagraphAudio(0), 200);
    }
  };

  const handlePrev = () => {
    if (activeParagraphIndex === null) return;
    currentAudioBufferRef.current = null;
    elapsedOffsetRef.current = 0;
    if (activeParagraphIndex > 0) {
      playParagraphAudio(activeParagraphIndex - 1);
    } else if (activeChapterIndex > 0) {
      const prevIdx = activeChapterIndex - 1;
      setActiveChapterIndex(prevIdx);
      setActiveParagraphIndex(null);
      if (isPlaying) {
        setTimeout(() => {
          const prev = currentBook.chapters[prevIdx];
          playParagraphAudio(prev.paragraphs.length - 1);
        }, 200);
      }
    }
  };

  const handleChapterSelect = (index: number) => {
    stopAudioInternal();
    setIsPlaying(false);
    setActiveChapterIndex(index);
    setActiveParagraphIndex(null);
    elapsedOffsetRef.current = 0;
    currentAudioBufferRef.current = null;
    if (paragraphsContainerRef.current) paragraphsContainerRef.current.scrollTop = 0;
  };

  const handleParagraphClick = (pIndex: number) => {
    currentAudioBufferRef.current = null;
    elapsedOffsetRef.current = 0;
    playParagraphAudio(pIndex);
  };

  // Cuộn 1 đoạn văn cụ thể (theo index truyền vào) vào giữa màn hình.
  // Không phụ thuộc vào state React nên luôn chính xác kể cả khi tự động
  // chuyển đoạn (state activeParagraphIndex có thể chưa kịp cập nhật/re-render).
  const scrollParagraphIntoView = (pIndex: number) => {
    document
      .getElementById(`p-node-${pIndex}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const scrollActiveParagraphIntoView = () => {
    if (activeParagraphIndex === null) return;
    document
      .getElementById(`p-node-${activeParagraphIndex}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // ── EPUB upload ─────────────────────────────────────────────────────────────
  const resetToUpload = () => {
    stopAudioInternal();
    setIsPlaying(false);
    setActiveParagraphIndex(null);
    elapsedOffsetRef.current = 0;
    currentAudioBufferRef.current = null;
    clearAudioQueue();
    setUploadedBook(null);
    setCurrentBook(EMPTY_BOOK);
    setParseError(null);
    setActiveChapterIndex(0);
  };

  const parseEpubFile = async (file: File) => {
    setIsParsing(true);
    setParseProgress(5);
    setParseError(null);
    stopAudioInternal();
    setIsPlaying(false);
    setActiveParagraphIndex(null);
    elapsedOffsetRef.current = 0;
    currentAudioBufferRef.current = null;
    clearAudioQueue();

    try {
      const buffer = await file.arrayBuffer();
      setParseProgress(10);
      const book = await parseEpubBuffer(buffer, setParseProgress);
      setUploadedBook(book);
      setCurrentBook(book);
      setActiveChapterIndex(0);
      setParseProgress(100);
      setTimeout(() => setIsParsing(false), 400);
    } catch (err: any) {
      setParseError(err.message || "Lỗi phân tích file EPUB.");
      setIsParsing(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) parseEpubFile(file);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file?.name.endsWith(".epub")) parseEpubFile(file);
    else setParseError("Chỉ chấp nhận file .epub");
  };

  // ── Theme ───────────────────────────────────────────────────────────────────
  const getTheme = () => {
    switch (readerTheme) {
      case "sepia": return {
        bg:"bg-[#F7F3E9]", text:"text-[#3D2C1D]", accentBg:"bg-[#EAE2CE]",
        accentText:"text-[#855D38]", card:"bg-[#F1EAD8] border-[#DFD4BA]",
        sidebar:"bg-[#EFE9D7] border-r border-[#E0D5B6]",
        activeP:"bg-[#E9DFBF] border-l-4 border-[#A05C20]", hoverP:"hover:bg-[#EFEBDB]",
      };
      case "charcoal": return {
        bg:"bg-[#2A2B2D]", text:"text-[#E3E3E3]", accentBg:"bg-[#3A3C3E]",
        accentText:"text-[#38BDF8]", card:"bg-[#1F2022] border-[#3F4145]",
        sidebar:"bg-[#232425] border-r border-[#3F4145]",
        activeP:"bg-[#343638] border-l-4 border-[#38BDF8]", hoverP:"hover:bg-[#2F3032]",
      };
      case "night": return {
        bg:"bg-[#0F172A]", text:"text-[#E2E8F0]", accentBg:"bg-[#1E293B]",
        accentText:"text-[#38BDF8]", card:"bg-[#0B1329] border-[#1E293B]",
        sidebar:"bg-[#090D1A] border-r border-[#1E293B]",
        activeP:"bg-[#1E293B] border-l-4 border-[#38BDF8]", hoverP:"hover:bg-[#151F32]",
      };
      default: return {
        bg:"bg-white", text:"text-[#1E293B]", accentBg:"bg-[#F1F5F9]",
        accentText:"text-[#2563EB]", card:"bg-[#F8FAFC] border-[#E2E8F0]",
        sidebar:"bg-[#F8FAFC] border-r border-[#E2E8F0]",
        activeP:"bg-[#EDF4FF] border-l-4 border-[#2563EB]", hoverP:"hover:bg-[#F1F5F9]",
      };
    }
  };

  const fontClass = fontFamily === "serif"
    ? "font-serif tracking-normal leading-relaxed"
    : fontFamily === "mono"
    ? "font-mono tracking-tight leading-relaxed"
    : "font-sans tracking-wide leading-relaxed";

  const sizeClass = fontSize === "sm" ? "text-sm" : fontSize === "lg" ? "text-lg" : fontSize === "xl" ? "text-xl" : "text-base";

  const theme = getTheme();
  const currentChapter = currentBook.chapters[activeChapterIndex];

  // Giọng đọc — key format: "piper:xxx" | "nghitts:xxx"
  const allVoiceEntries = Object.entries(voices);
  const piperVoices = allVoiceEntries.filter(([k]) => k.startsWith("piper:"));
  const nghittsVoices = allVoiceEntries.filter(([k]) => k.startsWith("nghitts:"));
  // fallback khi server chưa trả về
  const voiceOptions: [string, VoiceInfo][] = allVoiceEntries.length > 0 ? allVoiceEntries : [
    ["piper:vais1000-medium", { label: "VAIS1000 (Nữ - Chất lượng cao)", engine: "piper", downloaded: false, model: "" } as any],
  ];

  return (
    <div className={`flex flex-col h-screen overflow-hidden ${theme.bg} ${theme.text} transition-colors duration-300 font-sans`}>
      
      {/* Header */}
      <header className={`flex items-center justify-between px-6 py-4 border-b bg-black/5 backdrop-blur-md z-10 shrink-0`}>
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-amber-600 text-white shadow-md">
            <BookOpen size={22} />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight font-serif">Sách Nói EPUB</h1>
            <p className="text-xs opacity-60 font-mono">Piper TTS · CPU-only · Offline</p>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-4">
          <a
            href="/calibre-manager"
            className="px-3 py-1.5 rounded-md transition-all font-medium flex items-center gap-1.5 text-xs bg-black/5 hover:bg-black/10"
            title="Mở trình quản lý thư viện Calibre (Calibre Manager)"
          >
            <Library size={14} /> Calibre Manager
          </a>
          <a
            href="/epub2audiobook"
            className="px-3 py-1.5 rounded-md transition-all font-medium flex items-center gap-1.5 text-xs bg-black/5 hover:bg-black/10"
            title="Chuyển EPUB thành các file MP3 (audiobook)"
          >
            <Mic size={14} /> Tạo Audiobook
          </a>
          {uploadedBook && (
            <button
              onClick={resetToUpload}
              className="px-3 py-1.5 rounded-md transition-all font-medium flex items-center gap-1.5 text-xs bg-black/5 hover:bg-black/10"
            >
              <Upload size={14} /> Tải EPUB khác
            </button>
          )}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`p-2.5 rounded-lg border transition-all ${showSettings ? "bg-amber-600 text-white border-transparent" : "bg-black/5 border-black/10 hover:bg-black/10"}`}
          ><Sliders size={18} /></button>
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden relative">
        
        {/* Sidebar */}
        {uploadedBook && (
        <aside className={`hidden md:flex flex-col w-80 shrink-0 ${theme.sidebar}`}>
          <div className="p-5 border-b border-black/5">
            <span className="inline-block text-[10px] uppercase tracking-widest font-mono bg-amber-600/10 text-amber-600 px-2 py-0.5 rounded-full font-bold mb-3">
              EPUB đã tải
            </span>
            <h2 className="text-lg font-bold font-serif line-clamp-2 leading-snug">{currentBook.title}</h2>
            <p className="text-sm opacity-60 mt-1 italic font-serif">Tác giả: {currentBook.creator}</p>
            <div className="flex items-center justify-between text-xs opacity-50 font-mono mt-4 pt-4 border-t border-black/5">
              <span>{currentBook.chapters.length} chương</span>
              <span>{currentBook.chapters.reduce((a, c) => a + c.paragraphs.length, 0)} đoạn</span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-amber-600 mb-3 px-1 font-mono">Mục lục</h3>
            {currentBook.chapters.map((chapter, idx) => (
              <button
                key={chapter.id}
                onClick={() => handleChapterSelect(idx)}
                className={`w-full text-left p-3 rounded-xl transition-all border flex items-start gap-2.5 group ${idx === activeChapterIndex ? "bg-amber-600 text-white border-transparent shadow-sm" : "bg-black/5 border-transparent hover:bg-black/10"}`}
              >
                <BookOpen size={16} className={`mt-0.5 shrink-0 ${idx === activeChapterIndex ? "text-white" : "opacity-50"}`} />
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium leading-snug line-clamp-2 ${idx === activeChapterIndex ? "font-semibold" : ""}`}>{chapter.title}</p>
                  <p className={`text-[11px] mt-0.5 font-mono ${idx === activeChapterIndex ? "text-amber-100" : "opacity-50"}`}>{chapter.paragraphs.length} đoạn</p>
                </div>
                <ChevronRight size={14} className={`shrink-0 mt-1 ${idx === activeChapterIndex ? "text-white" : "opacity-30"}`} />
              </button>
            ))}
          </div>

          <div className="p-4 border-t border-black/5 bg-black/5 flex items-center justify-between text-xs opacity-75">
            <div className="flex items-center gap-1.5 font-mono">
              <Mic size={14} className="text-amber-500" />
              <span>{voices[ttsVoice]?.label?.split(" ")[0] ?? ttsVoice}</span>
            </div>
            <span className="font-mono">{playbackSpeed}x</span>
          </div>
        </aside>
        )}

        {/* Main content */}
        <main className="flex-1 flex flex-col overflow-hidden relative">
          
          {/* Settings panel */}
          <AnimatePresence>
            {showSettings && (
              <motion.div
                initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
                className={`absolute top-0 inset-x-0 p-5 ${theme.card} border-b z-20 shadow-xl grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6`}
              >
                {/* Theme */}
                <div>
                  <h4 className="text-xs font-bold uppercase tracking-wider mb-2.5 opacity-60 font-mono">Giao diện</h4>
                  <div className="grid grid-cols-4 gap-2">
                    {(["light","sepia","charcoal","night"] as ReaderTheme[]).map((t) => {
                      const labels = { light:"Sáng", sepia:"Giấy", charcoal:"Xám", night:"Tối" };
                      const bg = { light:"bg-white border-gray-200", sepia:"bg-[#F7F3E9] border-[#EAD2B8]", charcoal:"bg-[#2A2B2D] border-gray-600", night:"bg-[#0F172A] border-gray-800" };
                      return (
                        <button key={t} onClick={() => setReaderTheme(t)}
                          className={`flex flex-col items-center justify-center py-2.5 rounded-lg border-2 text-xs font-medium ${bg[t]} ${t === readerTheme ? "border-amber-500 scale-[1.03]" : "border-transparent"}`}>
                          <span className={`w-4 h-4 rounded-full border border-black/10 ${t === "light" ? "bg-white" : t === "sepia" ? "bg-[#F1EAD8]" : t === "charcoal" ? "bg-[#1F2022]" : "bg-[#0B1329]"}`} />
                          <span className="mt-1 text-[10px] opacity-85">{labels[t]}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Font */}
                <div>
                  <h4 className="text-xs font-bold uppercase tracking-wider mb-2.5 opacity-60 font-mono">Kiểu chữ</h4>
                  <div className="grid grid-cols-3 gap-2">
                    {(["serif","sans","mono"] as const).map((f) => {
                      const cls = { serif:"font-serif", sans:"font-sans", mono:"font-mono" };
                      return (
                        <button key={f} onClick={() => setFontFamily(f)}
                          className={`py-2 rounded-lg border text-sm font-medium capitalize flex flex-col items-center ${cls[f]} ${f === fontFamily ? "bg-amber-600 text-white border-transparent" : "bg-black/5 border-transparent hover:bg-black/10"}`}>
                          <span className="text-base">Aa</span>
                          <span className="text-[10px] opacity-75 mt-0.5">{f}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Size */}
                <div>
                  <h4 className="text-xs font-bold uppercase tracking-wider mb-2.5 opacity-60 font-mono">Cỡ chữ</h4>
                  <div className="flex items-center gap-1 bg-black/5 p-1 rounded-lg">
                    {(["sm","md","lg","xl"] as const).map((s) => {
                      const lbl = { sm:"Nhỏ", md:"Vừa", lg:"Lớn", xl:"Cực lớn" };
                      return (
                        <button key={s} onClick={() => setFontSize(s)}
                          className={`flex-1 py-1.5 rounded text-xs font-medium transition-all ${s === fontSize ? "bg-amber-600 text-white shadow-sm" : "opacity-60 hover:opacity-100"}`}>
                          {lbl[s]}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Speed */}
                <div>
                  <h4 className="text-xs font-bold uppercase tracking-wider mb-2.5 opacity-60 font-mono">Tốc độ đọc</h4>
                  <div className="flex items-center gap-2">
                    <input type="range" min="0.75" max="2.0" step="0.25" value={playbackSpeed}
                      onChange={(e) => { setPlaybackSpeed(parseFloat(e.target.value)); clearAudioQueue(); }}
                      className="w-full h-1.5 bg-black/10 rounded-lg appearance-none cursor-pointer accent-amber-600" />
                    <span className="text-xs font-mono font-bold shrink-0">{playbackSpeed.toFixed(2)}x</span>
                  </div>
                  <p className="text-[10px] opacity-50 mt-2 font-mono">Tốc độ áp dụng cho đoạn tiếp theo.</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Reader */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {isParsing ? (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                <div className="relative w-20 h-20 mb-6">
                  <div className="absolute inset-0 rounded-full border-4 border-amber-600/20" />
                  <div className="absolute inset-0 rounded-full border-4 border-t-amber-600 animate-spin" />
                </div>
                <h3 className="text-lg font-bold font-serif mb-2">Đang phân tích EPUB...</h3>
                <div className="w-64 h-2 bg-black/10 rounded-full overflow-hidden mt-4">
                  <div className="h-full bg-amber-600 transition-all duration-300" style={{ width: `${parseProgress}%` }} />
                </div>
                <span className="text-xs font-mono opacity-50 mt-2">{parseProgress}%</span>
              </div>
            ) : parseError ? (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                <AlertCircle size={48} className="text-red-500 mb-4" />
                <h3 className="text-lg font-bold mb-2 text-red-500">Lỗi phân tích EPUB</h3>
                <p className="text-sm opacity-70 max-w-md mb-6">{parseError}</p>
                <button onClick={() => setParseError(null)}
                  className="px-5 py-2.5 rounded-xl bg-amber-600 text-white font-medium hover:bg-amber-700 flex items-center gap-2">
                  <RefreshCw size={16} /> Thử lại
                </button>
              </div>
            ) : !uploadedBook ? (
              <div className="flex-1 flex flex-col items-center justify-center p-8">
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleDrop}
                  className="w-full max-w-xl p-12 border-2 border-dashed border-black/10 rounded-3xl flex flex-col items-center text-center bg-black/2 hover:bg-black/5 hover:border-amber-600/50 transition-all cursor-pointer relative group"
                >
                  <input type="file" accept=".epub" onChange={handleFileUpload}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
                  <div className="w-20 h-20 rounded-2xl bg-amber-600/10 text-amber-600 flex items-center justify-center mb-6 group-hover:scale-105 transition-transform">
                    <Upload size={38} />
                  </div>
                  <h3 className="text-xl font-bold font-serif mb-2">Tải sách EPUB lên</h3>
                  <p className="text-sm opacity-60 max-w-sm mb-6">Kéo thả hoặc nhấp để chọn file .epub</p>
                  <div className="flex flex-wrap items-center justify-center gap-3 text-xs font-mono opacity-50 border-t border-black/5 pt-6 w-full">
                    <span>Hỗ trợ EPUB2 & EPUB3</span><span>•</span>
                    <span>Đọc không giới hạn</span><span>•</span>
                    <span>Piper TTS offline</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col overflow-hidden">
                {/* Chapter nav bar */}
                <div className="flex items-center justify-between px-6 py-2.5 bg-black/5 border-b border-black/5 text-xs font-mono">
                  <button onClick={() => activeChapterIndex > 0 && handleChapterSelect(activeChapterIndex - 1)}
                    disabled={activeChapterIndex === 0}
                    className="flex items-center gap-1 opacity-70 hover:opacity-100 disabled:opacity-30">
                    <ChevronLeft size={14} /> Trước
                  </button>
                  <select value={activeChapterIndex}
                    onChange={(e) => handleChapterSelect(parseInt(e.target.value))}
                    className="bg-transparent font-medium py-1 px-2 rounded font-serif max-w-[200px] text-center focus:outline-none">
                    {currentBook.chapters.map((c, i) => (
                      <option key={c.id} value={i} className="text-black bg-white">{c.title}</option>
                    ))}
                  </select>
                  <button onClick={() => activeChapterIndex < currentBook.chapters.length - 1 && handleChapterSelect(activeChapterIndex + 1)}
                    disabled={activeChapterIndex === currentBook.chapters.length - 1}
                    className="flex items-center gap-1 opacity-70 hover:opacity-100 disabled:opacity-30">
                    Kế tiếp <ChevronRight size={14} />
                  </button>
                </div>

                {/* Error banner */}
                {audioError && (
                  <div className="bg-red-500/10 text-red-500 px-6 py-3 border-b border-red-500/20 text-xs flex justify-between items-center font-mono">
                    <span className="truncate flex-1">⚠️ {audioError}</span>
                    <button onClick={() => setAudioError(null)} className="ml-3 font-bold hover:underline shrink-0">✕</button>
                  </div>
                )}

                {/* Paragraphs */}
                <div ref={paragraphsContainerRef} className="flex-1 overflow-y-auto px-6 py-8 sm:px-16 sm:py-12">
                  <div className="max-w-2xl mx-auto">
                    <div className="text-center mb-12 border-b border-black/5 pb-8">
                      <p className="text-xs font-bold uppercase tracking-widest text-amber-600 font-mono mb-2">Chương {activeChapterIndex + 1}</p>
                      <h2 className="text-2xl sm:text-3xl font-bold font-serif leading-tight">{currentChapter?.title}</h2>
                    </div>
                    <div className="space-y-6 sm:space-y-8">
                      {currentChapter?.paragraphs.map((para) => {
                        const isActive = para.index === activeParagraphIndex;
                        return (
                          <div
                            key={para.id}
                            id={`p-node-${para.index}`}
                            onClick={() => handleParagraphClick(para.index)}
                            className={`p-4 rounded-2xl border transition-all duration-300 cursor-pointer flex gap-4 items-start ${fontClass} ${sizeClass} ${isActive ? theme.activeP + " shadow-md border-transparent" : `border-transparent ${theme.hoverP}`}`}
                          >
                            <div className="mt-1 shrink-0">
                              {isActive ? (
                                <div className="flex gap-0.5 items-center justify-center h-5 w-5 bg-amber-600 text-white rounded-full p-1 shadow-sm">
                                  {isPlaying && !isLoadingAudio ? (
                                    <div className="flex gap-0.5 items-end h-2.5 w-2.5">
                                      <span className="w-0.5 bg-white animate-pulse h-full" />
                                      <span className="w-0.5 bg-white animate-pulse h-1/2" style={{ animationDelay: "0.2s" }} />
                                      <span className="w-0.5 bg-white animate-pulse h-3/4" style={{ animationDelay: "0.4s" }} />
                                    </div>
                                  ) : (
                                    <Play size={10} className="fill-current ml-0.5" />
                                  )}
                                </div>
                              ) : (
                                <span className="text-[10px] font-mono opacity-25 w-5 h-5 flex items-center justify-center border border-current rounded-full">
                                  {para.index + 1}
                                </span>
                              )}
                            </div>
                            <p className="flex-1 text-justify select-text leading-relaxed">{para.text}</p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Scroll to active */}
          {activeParagraphIndex !== null && (
            <button onClick={scrollActiveParagraphIntoView}
              className="absolute right-6 bottom-32 bg-amber-600 text-white p-3 rounded-full shadow-xl hover:bg-amber-700 transition-all z-10 flex items-center gap-1.5 text-xs font-semibold">
              <Clock size={16} /> Đang đọc
            </button>
          )}
        </main>
      </div>

      {/* Footer playbar */}
      <footer className="border-t bg-black/5 border-black/10 z-10 shadow-2xl">
        <div className="max-w-5xl mx-auto px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          
          {/* Status */}
          <div className="flex items-center gap-3 w-full sm:w-auto min-w-0">
            {activeParagraphIndex !== null && currentChapter ? (
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="p-2 rounded-lg bg-amber-600 text-white shrink-0">
                  <Volume2 size={16} className={isPlaying && !isLoadingAudio ? "animate-pulse" : ""} />
                </div>
                <div className="min-w-0 text-left">
                  <p className="text-[10px] font-mono opacity-50 uppercase tracking-widest">Đang đọc</p>
                  <p className="text-sm font-semibold truncate">{currentChapter.title}</p>
                  <p className="text-[11px] opacity-65 truncate">Đoạn {activeParagraphIndex + 1}/{currentChapter.paragraphs.length}</p>
                </div>
              </div>
            ) : (
              <span className="text-xs opacity-50 font-mono italic">Nhấn vào đoạn văn để bắt đầu nghe</span>
            )}
          </div>

          {/* Controls */}
          <div className="flex items-center gap-3">
            <button onClick={handlePrev} disabled={activeParagraphIndex === null}
              className="p-2.5 rounded-xl hover:bg-black/10 disabled:opacity-20 disabled:pointer-events-none">
              <SkipBack size={18} />
            </button>
            <button onClick={togglePlayPause} disabled={isLoadingAudio}
              className={`w-12 h-12 rounded-full flex items-center justify-center text-white shadow-md hover:scale-105 active:scale-95 transition-all ${isLoadingAudio ? "bg-amber-600/60" : isPlaying ? "bg-amber-700" : "bg-amber-600"}`}>
              {isLoadingAudio ? (
                <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
              ) : isPlaying ? (
                <Pause size={20} className="fill-current" />
              ) : (
                <Play size={20} className="fill-current ml-0.5" />
              )}
            </button>
            <button onClick={handleStop} disabled={activeParagraphIndex === null}
              className="p-2.5 rounded-xl hover:bg-black/10 disabled:opacity-20 disabled:pointer-events-none">
              <Square size={16} className="fill-current" />
            </button>
            <button onClick={handleNext} disabled={activeParagraphIndex === null}
              className="p-2.5 rounded-xl hover:bg-black/10 disabled:opacity-20 disabled:pointer-events-none">
              <SkipForward size={18} />
            </button>
          </div>

          {/* Voice selector */}
          <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
            <span className="text-xs font-mono opacity-50 shrink-0">Giọng:</span>
            <select value={ttsVoice} onChange={(e) => { setTtsVoice(e.target.value); currentAudioBufferRef.current = null; clearAudioQueue(); }}
              className="text-xs bg-black/5 font-medium py-1.5 px-3 rounded-lg border border-black/10 focus:outline-none cursor-pointer max-w-[220px]">
              {piperVoices.length > 0 && (
                <optgroup label="── Piper TTS (CPU, nhanh)">
                  {piperVoices.map(([key, info]) => (
                    <option key={key} value={key}>
                      {(info as any).label}{!(info as any).downloaded && voicesLoaded ? " ⚠" : ""}
                    </option>
                  ))}
                </optgroup>
              )}
              {nghittsVoices.length > 0 && (
                <optgroup label="── Nghi-TTS (github.com/nghimestudio/nghitts)">
                  {nghittsVoices.map(([key, info]) => (
                    <option key={key} value={key}>
                      {(info as any).label}{!(info as any).downloaded && voicesLoaded ? " ⚠" : ""}
                    </option>
                  ))}
                </optgroup>
              )}
              {voiceOptions.length > 0 && piperVoices.length === 0 && nghittsVoices.length === 0 && voiceOptions.map(([key, info]) => (
                <option key={key} value={key}>{(info as any).label}</option>
              ))}
            </select>
          </div>
        </div>
      </footer>
    </div>
  );
}
