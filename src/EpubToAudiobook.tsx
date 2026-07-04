import React, { useEffect, useRef, useState } from "react";
import { Mp3Encoder } from "@breezystack/lamejs";
import {
  Upload,
  BookOpen,
  Mic,
  Download,
  Play,
  Pause,
  Square,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Loader2,
  FileArchive,
  ArrowLeft,
  ListChecks,
} from "lucide-react";
import { Book } from "./types";
import { parseEpubBuffer } from "./epubParser";

// ─── Cấu hình ────────────────────────────────────────────────────────────────
const SILENCE_BETWEEN_PARAGRAPHS_MS = 450; // khoảng lặng giữa 2 đoạn văn
const SILENCE_AFTER_TITLE_MS = 700; // khoảng lặng sau khi đọc tên chương
const MP3_BITRATE_KBPS = 128;
const MAX_RETRIES_PER_PARAGRAPH = 3;

interface VoiceInfo {
  label: string;
  engine: string;
  voice_key: string;
  downloaded: boolean;
}

// ─── Cầu nối nhận sách từ trang Calibre Manager ─────────────────────────────
// Khi người dùng bấm "🎧 Tạo Audiobook" trong lúc đang đọc 1 cuốn EPUB ở
// Calibre Manager (/calibre-manager), trang đó lưu tạm chính file EPUB (Blob
// thật) vào IndexedDB rồi điều hướng sang đây. Trang này đọc lại đúng key đó
// để tự động nạp sách, không bắt người dùng chọn lại file. Dùng chung tên
// DB/store/key với public/calibre/app.js (hàm sendEpubToAudiobook()).
const EPUB_BRIDGE_DB_NAME = "epub_reader_bridge";
const EPUB_BRIDGE_STORE = "transfer";
const EPUB_BRIDGE_KEY = "pending_audiobook";

interface BridgedEpubPayload {
  title: string;
  blob: Blob;
  ts: number;
}

function openBridgeDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("Trình duyệt không hỗ trợ IndexedDB"));
      return;
    }
    const req = indexedDB.open(EPUB_BRIDGE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(EPUB_BRIDGE_STORE)) {
        req.result.createObjectStore(EPUB_BRIDGE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Không mở được IndexedDB"));
  });
}

// Đọc rồi xoá ngay dữ liệu sách đang chờ chuyển từ Calibre Manager (nếu có).
// Trả về null khi không có gì đang chờ — trường hợp bình thường, người dùng
// vào thẳng trang này để tự tải EPUB lên như cũ.
async function consumeBridgedEpub(): Promise<BridgedEpubPayload | null> {
  try {
    const idb = await openBridgeDb();
    const payload = await new Promise<BridgedEpubPayload | null>((resolve, reject) => {
      const tx = idb.transaction(EPUB_BRIDGE_STORE, "readwrite");
      const store = tx.objectStore(EPUB_BRIDGE_STORE);
      const getReq = store.get(EPUB_BRIDGE_KEY);
      getReq.onsuccess = () => {
        const value = getReq.result as BridgedEpubPayload | undefined;
        if (value) store.delete(EPUB_BRIDGE_KEY);
        resolve(value ?? null);
      };
      getReq.onerror = () => reject(getReq.error);
    });
    idb.close();
    return payload;
  } catch {
    return null; // IndexedDB không khả dụng hoặc không có dữ liệu -> bỏ qua lặng lẽ
  }
}

type ChapterStatus = "pending" | "processing" | "done" | "error" | "cancelled";

interface ChapterJob {
  bookIndex: number; // vị trí thật của chương trong sách (để đặt tên file đúng thứ tự)
  title: string;
  totalParagraphs: number;
  doneParagraphs: number;
  status: ChapterStatus;
  error?: string;
  blob?: Blob;
  url?: string;
  sizeBytes?: number;
  durationSec?: number;
}

// ─── Tiện ích ────────────────────────────────────────────────────────────────

// Đọc Blob thành chuỗi base64 (không kèm phần "data:...;base64," ở đầu)
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const commaIdx = result.indexOf(",");
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Lưu file xuống máy.
// - Khi chạy trong bản .exe (cửa sổ pywebview): trình duyệt lồng bên trong
//   (WebView2) KHÔNG hỗ trợ tải file từ blob: URL qua thẻ <a download> như
//   Chrome/Edge thật, nên bấm "Tải" sẽ không có gì xảy ra. Ta phải gửi dữ
//   liệu qua cầu nối window.pywebview.api để Python mở hộp thoại "Lưu file"
//   và ghi file thật ra đĩa.
// - Khi chạy trên trình duyệt bình thường (start.bat / npm run dev): dùng
//   cách cũ (tạo blob URL + click thẻ <a download>), vẫn hoạt động tốt.
async function saveBlob(blob: Blob, filename: string): Promise<void> {
  const pywebviewApi = (window as any).pywebview?.api;
  if (pywebviewApi && typeof pywebviewApi.save_blob === "function") {
    const base64 = await blobToBase64(blob);
    await pywebviewApi.save_blob(filename, base64);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "Chuong";
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Giải mã base64 (PCM 16-bit little-endian, mono) → Int16Array, đúng định dạng
// mà /api/tts trả về và cũng đúng định dạng mà Mp3Encoder.encodeBuffer() cần.
function decodeBase64PCM16(base64: string): Int16Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  const numSamples = Math.floor(len / 2);
  const view = new DataView(bytes.buffer);
  const out = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

function silenceSamples(ms: number, sampleRate: number): Int16Array {
  const n = Math.round((ms / 1000) * sampleRate);
  return new Int16Array(n); // toàn số 0 = im lặng
}

function concatInt16(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function encodeMp3(pcm: Int16Array, sampleRate: number): Blob {
  const encoder = new Mp3Encoder(1, sampleRate, MP3_BITRATE_KBPS);
  const blockSize = 1152;
  const mp3Chunks: Uint8Array[] = [];
  for (let i = 0; i < pcm.length; i += blockSize) {
    const chunk = pcm.subarray(i, i + blockSize);
    const encoded = encoder.encodeBuffer(chunk as any);
    if (encoded.length > 0) mp3Chunks.push(new Uint8Array(encoded));
  }
  const end = encoder.flush();
  if (end.length > 0) mp3Chunks.push(new Uint8Array(end));
  return new Blob(mp3Chunks as BlobPart[], { type: "audio/mpeg" });
}

async function fetchTTSData(
  text: string,
  engine: string,
  voiceKey: string,
  speed: number
): Promise<{ audio: string; sampleRate: number }> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, engine, voice: voiceKey, speed }),
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || `Lỗi TTS server (HTTP ${res.status})`);
  }
  const data = await res.json();
  if (!data.audio) throw new Error("Server không trả về dữ liệu âm thanh.");
  return { audio: data.audio as string, sampleRate: (data.sampleRate ?? 22050) as number };
}

async function fetchTTSWithRetry(
  text: string,
  engine: string,
  voiceKey: string,
  speed: number
): Promise<{ audio: string; sampleRate: number }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES_PER_PARAGRAPH; attempt++) {
    try {
      return await fetchTTSData(text, engine, voiceKey, speed);
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES_PER_PARAGRAPH) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
  throw lastErr;
}

// ─── Component chính ─────────────────────────────────────────────────────────
export default function EpubToAudiobook() {
  const [book, setBook] = useState<Book | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parseProgress, setParseProgress] = useState(0);
  const [parseError, setParseError] = useState<string | null>(null);

  const [voices, setVoices] = useState<Record<string, VoiceInfo>>({});
  const [voicesLoaded, setVoicesLoaded] = useState(false);
  const [ttsVoice, setTtsVoice] = useState("");
  const [speed, setSpeed] = useState(1.0);
  const [readTitleAloud, setReadTitleAloud] = useState(true);

  const [selectedChapters, setSelectedChapters] = useState<Set<number>>(new Set());
  const [jobs, setJobs] = useState<ChapterJob[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [fromCalibre, setFromCalibre] = useState(false);

  const cancelRef = useRef(false);
  const jobsRef = useRef<ChapterJob[]>([]);

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  // Tải danh sách giọng đọc từ server (dùng chung API với trang đọc)
  useEffect(() => {
    fetch("/api/voices")
      .then((r) => r.json())
      .then((data) => {
        const voicesData = data as Record<string, VoiceInfo>;
        setVoices(voicesData);
        setVoicesLoaded(true);
        const DEFAULT_VOICE_KEY = "nghitts:ngochuyennew";
        if (voicesData[DEFAULT_VOICE_KEY]?.downloaded) {
          setTtsVoice(DEFAULT_VOICE_KEY);
          return;
        }
        const downloaded = Object.entries(voicesData).find(([, v]) => v.downloaded);
        if (downloaded) setTtsVoice(downloaded[0]);
      })
      .catch(() => setVoicesLoaded(true));
  }, []);

  // Dọn dẹp URL blob khi rời trang
  useEffect(() => {
    return () => {
      jobsRef.current.forEach((j) => j.url && URL.revokeObjectURL(j.url));
    };
  }, []);

  const parseFile = async (file: File | Blob) => {
    setParseError(null);
    setIsParsing(true);
    setParseProgress(0);
    setBook(null);
    setJobs([]);
    try {
      const buffer = await file.arrayBuffer();
      const parsed = await parseEpubBuffer(buffer, setParseProgress);
      setBook(parsed);
      setSelectedChapters(new Set(parsed.chapters.map((_, i) => i)));
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Lỗi không xác định khi đọc EPUB.");
    } finally {
      setTimeout(() => setIsParsing(false), 300);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setFromCalibre(false);
      parseFile(file);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && file.name.toLowerCase().endsWith(".epub")) {
      setFromCalibre(false);
      parseFile(file);
    }
  };

  // Tự động nhận sách đang đọc từ Calibre Manager (nếu người dùng vừa bấm nút
  // "🎧 Tạo Audiobook" bên đó) ngay khi trang này được mở lên.
  useEffect(() => {
    (async () => {
      const bridged = await consumeBridgedEpub();
      if (bridged?.blob) {
        setFromCalibre(true);
        await parseFile(bridged.blob);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleChapter = (idx: number) => {
    setSelectedChapters((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const toggleAll = () => {
    if (!book) return;
    setSelectedChapters((prev) =>
      prev.size === book.chapters.length ? new Set() : new Set(book.chapters.map((_, i) => i))
    );
  };

  // ── Sinh audiobook: mỗi chương → 1 file mp3 riêng ────────────────────────
  const startGeneration = async () => {
    if (!book || selectedChapters.size === 0 || !ttsVoice) return;
    const [engine, voiceKey] = ttsVoice.includes(":") ? ttsVoice.split(":") : ["piper", ttsVoice];

    // Dọn audio cũ (nếu tạo lại)
    jobsRef.current.forEach((j) => j.url && URL.revokeObjectURL(j.url));

    const order = book.chapters
      .map((_, i) => i)
      .filter((i) => selectedChapters.has(i));

    const initialJobs: ChapterJob[] = order.map((bookIndex) => ({
      bookIndex,
      title: book.chapters[bookIndex].title,
      totalParagraphs: book.chapters[bookIndex].paragraphs.length,
      doneParagraphs: 0,
      status: "pending",
    }));
    setJobs(initialJobs);
    jobsRef.current = initialJobs;
    setGenError(null);
    cancelRef.current = false;
    setIsGenerating(true);

    const updateJob = (bookIndex: number, patch: Partial<ChapterJob>) => {
      setJobs((prev) => {
        const next = prev.map((j) => (j.bookIndex === bookIndex ? { ...j, ...patch } : j));
        jobsRef.current = next;
        return next;
      });
    };

    for (const bookIndex of order) {
      if (cancelRef.current) {
        updateJob(bookIndex, { status: "cancelled" });
        continue;
      }
      const chapter = book.chapters[bookIndex];
      updateJob(bookIndex, { status: "processing", doneParagraphs: 0 });

      const textsToSpeak: string[] = readTitleAloud
        ? [chapter.title, ...chapter.paragraphs.map((p) => p.text)]
        : chapter.paragraphs.map((p) => p.text);

      const pcmChunks: Int16Array[] = [];
      let sampleRate = 22050;
      let failCount = 0;

      for (let j = 0; j < textsToSpeak.length; j++) {
        if (cancelRef.current) break;
        try {
          const { audio, sampleRate: sr } = await fetchTTSWithRetry(
            textsToSpeak[j],
            engine,
            voiceKey,
            speed
          );
          sampleRate = sr;
          const pcm = decodeBase64PCM16(audio);
          pcmChunks.push(pcm);
          const gapMs = j === 0 && readTitleAloud ? SILENCE_AFTER_TITLE_MS : SILENCE_BETWEEN_PARAGRAPHS_MS;
          pcmChunks.push(silenceSamples(gapMs, sampleRate));
        } catch (e) {
          failCount++;
          // Bỏ qua đoạn lỗi, tiếp tục các đoạn còn lại để không mất cả chương
        }
        const doneCount = readTitleAloud ? j : j + 1;
        updateJob(bookIndex, { doneParagraphs: Math.max(0, doneCount) });
      }

      if (cancelRef.current) {
        updateJob(bookIndex, { status: "cancelled" });
        break;
      }

      if (pcmChunks.length === 0) {
        updateJob(bookIndex, { status: "error", error: "Không tạo được audio cho chương này." });
        continue;
      }

      try {
        const merged = concatInt16(pcmChunks);
        const blob = encodeMp3(merged, sampleRate);
        const url = URL.createObjectURL(blob);
        const durationSec = merged.length / sampleRate;
        updateJob(bookIndex, {
          status: "done",
          doneParagraphs: chapter.paragraphs.length,
          blob,
          url,
          sizeBytes: blob.size,
          durationSec,
          error:
            failCount > 0
              ? `Hoàn tất (bỏ qua ${failCount} đoạn lỗi sau ${MAX_RETRIES_PER_PARAGRAPH} lần thử)`
              : undefined,
        });
      } catch (e) {
        updateJob(bookIndex, {
          status: "error",
          error: e instanceof Error ? e.message : "Lỗi khi mã hoá MP3.",
        });
      }
    }

    setIsGenerating(false);
  };

  const cancelGeneration = () => {
    cancelRef.current = true;
  };

  const retryChapter = async (bookIndex: number) => {
    if (!book || isGenerating) return;
    const [engine, voiceKey] = ttsVoice.includes(":") ? ttsVoice.split(":") : ["piper", ttsVoice];
    const chapter = book.chapters[bookIndex];

    setJobs((prev) => prev.map((j) => (j.bookIndex === bookIndex ? { ...j, status: "processing", doneParagraphs: 0, error: undefined } : j)));
    setIsGenerating(true);
    cancelRef.current = false;

    const textsToSpeak: string[] = readTitleAloud
      ? [chapter.title, ...chapter.paragraphs.map((p) => p.text)]
      : chapter.paragraphs.map((p) => p.text);

    const pcmChunks: Int16Array[] = [];
    let sampleRate = 22050;
    let failCount = 0;

    for (let j = 0; j < textsToSpeak.length; j++) {
      if (cancelRef.current) break;
      try {
        const { audio, sampleRate: sr } = await fetchTTSWithRetry(textsToSpeak[j], engine, voiceKey, speed);
        sampleRate = sr;
        pcmChunks.push(decodeBase64PCM16(audio));
        const gapMs = j === 0 && readTitleAloud ? SILENCE_AFTER_TITLE_MS : SILENCE_BETWEEN_PARAGRAPHS_MS;
        pcmChunks.push(silenceSamples(gapMs, sampleRate));
      } catch {
        failCount++;
      }
      setJobs((prev) =>
        prev.map((j2) =>
          j2.bookIndex === bookIndex ? { ...j2, doneParagraphs: readTitleAloud ? j : j + 1 } : j2
        )
      );
    }

    if (pcmChunks.length === 0) {
      setJobs((prev) =>
        prev.map((j) => (j.bookIndex === bookIndex ? { ...j, status: "error", error: "Không tạo được audio." } : j))
      );
    } else {
      const merged = concatInt16(pcmChunks);
      const blob = encodeMp3(merged, sampleRate);
      const url = URL.createObjectURL(blob);
      setJobs((prev) =>
        prev.map((j) =>
          j.bookIndex === bookIndex
            ? {
                ...j,
                status: "done",
                blob,
                url,
                sizeBytes: blob.size,
                durationSec: merged.length / sampleRate,
                error: failCount > 0 ? `Hoàn tất (bỏ qua ${failCount} đoạn lỗi)` : undefined,
              }
            : j
        )
      );
    }
    setIsGenerating(false);
  };

  const chapterFileName = (job: ChapterJob) => {
    const num = String(job.bookIndex + 1).padStart(3, "0");
    return `${num} - ${sanitizeFileName(job.title)}.mp3`;
  };

  const downloadAllZip = async () => {
    // @ts-ignore – JSZip load qua CDN trong epub2audiobook.html
    const JSZip = (window as any).JSZip;
    if (!JSZip) {
      setGenError("Không tìm thấy JSZip để đóng gói file.");
      return;
    }
    const done = jobs.filter((j) => j.status === "done" && j.blob);
    if (done.length === 0) return;
    setIsZipping(true);
    try {
      const zip = new JSZip();
      done.forEach((j) => zip.file(chapterFileName(j), j.blob as Blob));
      const content: Blob = await zip.generateAsync({ type: "blob" });
      await saveBlob(content, `${sanitizeFileName(book?.title || "audiobook")}.zip`);
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "Lỗi khi tạo file ZIP.");
    } finally {
      setIsZipping(false);
    }
  };

  const totalParagraphsSelected = book
    ? book.chapters
        .filter((_, i) => selectedChapters.has(i))
        .reduce((a, c) => a + c.paragraphs.length, 0)
    : 0;

  const doneCount = jobs.filter((j) => j.status === "done").length;
  const errorCount = jobs.filter((j) => j.status === "error").length;
  const overallProgress = jobs.length > 0 ? Math.round(((doneCount + errorCount) / jobs.length) * 100) : 0;

  const voiceGroups = (() => {
    const entries = Object.entries(voices) as Array<[string, VoiceInfo]>;
    const downloaded = entries.filter(([, v]) => v.downloaded);
    const piper = downloaded.filter(([k]) => !k.startsWith("nghitts:"));
    const nghitts = downloaded.filter(([k]) => k.startsWith("nghitts:"));
    return { piper, nghitts };
  })();

  return (
    <div className="min-h-screen bg-[#0F1115] text-gray-100 font-sans">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-black/30 backdrop-blur-md sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-amber-600 text-white shadow-md">
            <Mic size={20} />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight font-serif">EPUB → Audiobook</h1>
            <p className="text-xs opacity-60 font-mono">Mỗi chương 1 file MP3 · Offline</p>
          </div>
        </div>
        <a
          href="/"
          className="px-3 py-1.5 rounded-md transition-all font-medium flex items-center gap-1.5 text-xs bg-white/5 hover:bg-white/10"
        >
          <ArrowLeft size={14} /> Về trang đọc
        </a>
      </header>

      <main className="max-w-5xl mx-auto p-6 space-y-6">
        {/* Upload */}
        {!book && !isParsing && (
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            className="w-full p-12 border-2 border-dashed border-white/15 rounded-3xl flex flex-col items-center text-center bg-white/[0.02] hover:bg-white/[0.04] hover:border-amber-600/50 transition-all cursor-pointer relative group"
          >
            <input
              type="file"
              accept=".epub"
              onChange={handleFileInput}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            <div className="w-20 h-20 rounded-2xl bg-amber-600/10 text-amber-500 flex items-center justify-center mb-6 group-hover:scale-105 transition-transform">
              <Upload size={38} />
            </div>
            <h3 className="text-xl font-bold font-serif mb-2">Tải sách EPUB lên</h3>
            <p className="text-sm opacity-60 max-w-sm mb-2">
              Kéo thả hoặc nhấp để chọn file .epub — ứng dụng sẽ tự nhận diện toàn bộ chương
            </p>
            <p className="text-xs opacity-40 font-mono">Hỗ trợ EPUB2 (NCX) & EPUB3 (nav)</p>
          </div>
        )}

        {isParsing && (
          <div className="flex flex-col items-center justify-center p-16 text-center">
            <div className="relative w-16 h-16 mb-6">
              <div className="absolute inset-0 rounded-full border-4 border-amber-600/20" />
              <div className="absolute inset-0 rounded-full border-4 border-t-amber-600 animate-spin" />
            </div>
            <h3 className="text-lg font-bold font-serif mb-2">
              {fromCalibre ? "Đang nhận sách từ Calibre Manager..." : "Đang phân tích EPUB..."}
            </h3>
            <div className="w-64 h-2 bg-white/10 rounded-full overflow-hidden mt-4">
              <div className="h-full bg-amber-600 transition-all duration-300" style={{ width: `${parseProgress}%` }} />
            </div>
          </div>
        )}

        {parseError && (
          <div className="p-8 text-center bg-red-500/10 border border-red-500/20 rounded-2xl">
            <AlertCircle size={40} className="text-red-500 mx-auto mb-3" />
            <h3 className="text-lg font-bold mb-2 text-red-400">Lỗi phân tích EPUB</h3>
            <p className="text-sm opacity-70 max-w-md mx-auto mb-5">{parseError}</p>
            <button
              onClick={() => setParseError(null)}
              className="px-5 py-2.5 rounded-xl bg-amber-600 text-white font-medium hover:bg-amber-700 inline-flex items-center gap-2"
            >
              <RefreshCw size={16} /> Thử lại
            </button>
          </div>
        )}

        {book && (
          <>
            {/* Thông tin sách */}
            <div className="bg-white/[0.03] border border-white/10 rounded-2xl p-5 flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <span className="inline-block text-[10px] uppercase tracking-widest font-mono bg-amber-600/10 text-amber-500 px-2 py-0.5 rounded-full font-bold mb-2">
                  EPUB đã tải
                </span>
                {fromCalibre && (
                  <span className="inline-block text-[10px] uppercase tracking-widest font-mono bg-sky-600/10 text-sky-400 px-2 py-0.5 rounded-full font-bold mb-2 ml-2">
                    📚 Từ Calibre Manager
                  </span>
                )}
                <h2 className="text-lg font-bold font-serif truncate">{book.title}</h2>
                <p className="text-sm opacity-60 italic font-serif">Tác giả: {book.creator}</p>
                <p className="text-xs opacity-50 font-mono mt-2">
                  {book.chapters.length} chương · {book.chapters.reduce((a, c) => a + c.paragraphs.length, 0)} đoạn văn
                </p>
              </div>
              <label className="shrink-0 px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-xs font-medium flex items-center gap-1.5 cursor-pointer">
                <Upload size={13} /> Tải EPUB khác
                <input type="file" accept=".epub" onChange={handleFileInput} className="hidden" />
              </label>
            </div>

            {/* Cấu hình giọng đọc */}
            <div className="bg-white/[0.03] border border-white/10 rounded-2xl p-5 grid grid-cols-1 sm:grid-cols-3 gap-5">
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider mb-2 opacity-60 font-mono">Giọng đọc</h4>
                {!voicesLoaded ? (
                  <p className="text-xs opacity-50">Đang tải danh sách giọng...</p>
                ) : voiceGroups.piper.length === 0 && voiceGroups.nghitts.length === 0 ? (
                  <p className="text-xs text-red-400">Chưa có giọng nào được tải. Chạy start.bat hoặc --download.</p>
                ) : (
                  <select
                    value={ttsVoice}
                    onChange={(e) => setTtsVoice(e.target.value)}
                    disabled={isGenerating}
                    className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-amber-600"
                  >
                    {voiceGroups.piper.length > 0 && (
                      <optgroup label="Piper TTS">
                        {voiceGroups.piper.map(([k, v]) => (
                          <option key={k} value={k}>{v.label}</option>
                        ))}
                      </optgroup>
                    )}
                    {voiceGroups.nghitts.length > 0 && (
                      <optgroup label="Nghi-TTS">
                        {voiceGroups.nghitts.map(([k, v]) => (
                          <option key={k} value={k}>{v.label}</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                )}
              </div>

              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider mb-2 opacity-60 font-mono">Tốc độ đọc</h4>
                <div className="flex items-center gap-2">
                  <input
                    type="range" min="0.75" max="2.0" step="0.25" value={speed}
                    disabled={isGenerating}
                    onChange={(e) => setSpeed(parseFloat(e.target.value))}
                    className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-amber-600"
                  />
                  <span className="text-xs font-mono font-bold shrink-0">{speed.toFixed(2)}x</span>
                </div>
              </div>

              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider mb-2 opacity-60 font-mono">Tuỳ chọn</h4>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={readTitleAloud}
                    disabled={isGenerating}
                    onChange={(e) => setReadTitleAloud(e.target.checked)}
                    className="accent-amber-600 w-4 h-4"
                  />
                  Đọc tên chương trước nội dung
                </label>
              </div>
            </div>

            {/* Danh sách chương */}
            <div className="bg-white/[0.03] border border-white/10 rounded-2xl overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b border-white/10 bg-white/[0.02]">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider opacity-70 font-mono">
                  <ListChecks size={14} /> Chọn chương ({selectedChapters.size}/{book.chapters.length})
                </div>
                <button
                  onClick={toggleAll}
                  disabled={isGenerating}
                  className="text-xs px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 font-medium"
                >
                  {selectedChapters.size === book.chapters.length ? "Bỏ chọn tất cả" : "Chọn tất cả"}
                </button>
              </div>
              <div className="max-h-72 overflow-y-auto divide-y divide-white/5">
                {book.chapters.map((c, idx) => {
                  const job = jobs.find((j) => j.bookIndex === idx);
                  return (
                    <label
                      key={c.id}
                      className="flex items-center gap-3 px-5 py-2.5 hover:bg-white/[0.03] cursor-pointer text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={selectedChapters.has(idx)}
                        disabled={isGenerating}
                        onChange={() => toggleChapter(idx)}
                        className="accent-amber-600 w-4 h-4 shrink-0"
                      />
                      <span className="opacity-40 font-mono text-xs w-8 shrink-0">{String(idx + 1).padStart(2, "0")}</span>
                      <span className="flex-1 truncate">{c.title}</span>
                      <span className="text-xs opacity-40 font-mono shrink-0">{c.paragraphs.length} đoạn</span>
                      {job && <ChapterStatusBadge job={job} />}
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Nút tạo audiobook */}
            {genError && (
              <div className="bg-red-500/10 text-red-400 px-4 py-3 rounded-lg text-sm flex justify-between items-center">
                <span>⚠️ {genError}</span>
                <button onClick={() => setGenError(null)} className="font-bold hover:underline shrink-0 ml-3">✕</button>
              </div>
            )}

            <div className="flex items-center gap-3 flex-wrap">
              {!isGenerating ? (
                <button
                  onClick={startGeneration}
                  disabled={selectedChapters.size === 0 || !ttsVoice}
                  className="px-5 py-2.5 rounded-xl bg-amber-600 text-white font-medium hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  <Mic size={16} />
                  {jobs.length > 0 ? "Tạo lại audiobook" : "Bắt đầu tạo audiobook"}
                  <span className="text-xs opacity-75 font-mono">({totalParagraphsSelected} đoạn)</span>
                </button>
              ) : (
                <button
                  onClick={cancelGeneration}
                  className="px-5 py-2.5 rounded-xl bg-red-600 text-white font-medium hover:bg-red-700 flex items-center gap-2"
                >
                  <Square size={16} /> Huỷ tạo
                </button>
              )}

              {doneCount > 0 && (
                <button
                  onClick={downloadAllZip}
                  disabled={isZipping}
                  className="px-5 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 font-medium flex items-center gap-2 disabled:opacity-50"
                >
                  {isZipping ? <Loader2 size={16} className="animate-spin" /> : <FileArchive size={16} />}
                  Tải tất cả (ZIP) — {doneCount} file
                </button>
              )}

              {jobs.length > 0 && (
                <div className="flex items-center gap-2 text-xs font-mono opacity-70 ml-auto">
                  <div className="w-32 h-1.5 bg-white/10 rounded-full overflow-hidden">
                    <div className="h-full bg-amber-600 transition-all duration-300" style={{ width: `${overallProgress}%` }} />
                  </div>
                  {overallProgress}% ({doneCount}/{jobs.length})
                </div>
              )}
            </div>

            {/* Kết quả từng chương */}
            {jobs.length > 0 && (
              <div className="bg-white/[0.03] border border-white/10 rounded-2xl divide-y divide-white/5 overflow-hidden">
                {jobs.map((job) => (
                  <ChapterResultRow
                    key={job.bookIndex}
                    job={job}
                    fileName={chapterFileName(job)}
                    onRetry={() => retryChapter(job.bookIndex)}
                    canRetry={!isGenerating}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function ChapterStatusBadge({ job }: { job: ChapterJob }) {
  if (job.status === "processing") {
    return (
      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-600/20 text-amber-400 flex items-center gap-1 shrink-0">
        <Loader2 size={10} className="animate-spin" /> {job.doneParagraphs}/{job.totalParagraphs}
      </span>
    );
  }
  if (job.status === "done") {
    return <CheckCircle2 size={14} className="text-green-500 shrink-0" />;
  }
  if (job.status === "error") {
    return <AlertCircle size={14} className="text-red-500 shrink-0" />;
  }
  if (job.status === "cancelled") {
    return <span className="text-[10px] font-mono opacity-40 shrink-0">đã huỷ</span>;
  }
  return null;
}

function ChapterResultRow({
  job,
  fileName,
  onRetry,
  canRetry,
}: {
  job: ChapterJob;
  fileName: string;
  onRetry: () => void;
  canRetry: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-5 py-3 flex-wrap">
      <BookOpen size={15} className="opacity-40 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">
          {String(job.bookIndex + 1).padStart(2, "0")}. {job.title}
        </p>
        <p className="text-[11px] opacity-50 font-mono">
          {job.status === "processing" && `Đang tạo... ${job.doneParagraphs}/${job.totalParagraphs} đoạn`}
          {job.status === "pending" && "Đang chờ"}
          {job.status === "done" && `${formatDuration(job.durationSec || 0)} · ${formatBytes(job.sizeBytes || 0)}`}
          {job.status === "error" && (job.error || "Lỗi")}
          {job.status === "cancelled" && "Đã huỷ"}
          {job.status === "done" && job.error && (
            <span className="text-amber-500 ml-1">· {job.error}</span>
          )}
        </p>
      </div>

      {job.status === "processing" && (
        <Loader2 size={16} className="animate-spin text-amber-500 shrink-0" />
      )}

      {job.status === "done" && job.url && (
        <>
          <audio controls src={job.url} className="h-8 w-48 shrink-0" />
          <button
            onClick={() => job.blob && saveBlob(job.blob, fileName)}
            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 shrink-0"
            title="Tải file mp3"
          >
            <Download size={15} />
          </button>
        </>
      )}

      {(job.status === "error" || job.status === "cancelled") && canRetry && (
        <button
          onClick={onRetry}
          className="p-2 rounded-lg bg-white/5 hover:bg-white/10 shrink-0 flex items-center gap-1.5 text-xs font-medium px-3"
          title="Thử lại chương này"
        >
          <RefreshCw size={14} /> Thử lại
        </button>
      )}
    </div>
  );
}
