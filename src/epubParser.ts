import { Book, Chapter, Paragraph } from "./types";

// ─── EPUB Parser (hỗ trợ OEBPS/contents/page*.xhtml) ─────────────────────
// Dùng chung cho trang đọc sách (App.tsx) và trang chuyển EPUB → Audiobook
// (EpubToAudiobook.tsx) để đảm bảo 2 trang luôn nhận diện chương giống hệt nhau.
export async function parseEpubBuffer(
  buffer: ArrayBuffer,
  onProgress: (p: number) => void
): Promise<Book> {
  // @ts-ignore – JSZip được load qua CDN trong index.html / epub2audiobook.html
  const JSZip = (window as any).JSZip;
  if (!JSZip) throw new Error("JSZip chưa được load. Kiểm tra index.html.");

  const zip = await JSZip.loadAsync(buffer);
  onProgress(20);

  // 1. Đọc container.xml → đường dẫn OPF
  const containerXml = await zip.file("META-INF/container.xml")?.async("string");
  if (!containerXml) throw new Error("Không tìm thấy META-INF/container.xml");
  const containerDoc = new DOMParser().parseFromString(containerXml, "application/xml");
  const opfPath = containerDoc
    .querySelector("rootfile")
    ?.getAttribute("full-path");
  if (!opfPath) throw new Error("Không tìm thấy OPF path trong container.xml");

  // 2. Đọc OPF → metadata + spine
  const opfXml = await zip.file(opfPath)?.async("string");
  if (!opfXml) throw new Error(`Không tìm thấy OPF file: ${opfPath}`);
  const opfDoc = new DOMParser().parseFromString(opfXml, "application/xml");
  const opfDir = opfPath.includes("/")
    ? opfPath.substring(0, opfPath.lastIndexOf("/") + 1)
    : "";

  // Metadata
  const getMetaText = (tag: string): string => {
    const el =
      opfDoc.querySelector(`metadata ${tag}`) ||
      opfDoc.querySelector(tag);
    return el?.textContent?.trim() || "";
  };
  const title = getMetaText("dc\\:title") || getMetaText("title") || "Không rõ tên";
  const creator = getMetaText("dc\\:creator") || getMetaText("creator") || "Tác giả ẩn danh";

  // Manifest: id → href
  const manifest: Record<string, string> = {};
  opfDoc.querySelectorAll("manifest item").forEach((item) => {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href) manifest[id] = href;
  });

  // Spine: thứ tự đọc
  const spineIds: string[] = [];
  opfDoc.querySelectorAll("spine itemref").forEach((ref) => {
    const idref = ref.getAttribute("idref");
    if (idref) spineIds.push(idref);
  });

  // 3. Tìm TOC (nav/ncx) để lấy tên chương
  const chapterTitles: Record<string, string> = {};

  // Thử EPUB3 nav document
  const navId = Array.from(opfDoc.querySelectorAll("manifest item")).find(
    (el) =>
      el.getAttribute("properties")?.includes("nav") ||
      el.getAttribute("media-type") === "application/xhtml+xml" &&
      el.getAttribute("href")?.includes("toc")
  );
  if (navId) {
    const navHref = navId.getAttribute("href") || "";
    const navFullPath = opfDir + navHref;
    const navXml = await zip.file(navFullPath)?.async("string");
    if (navXml) {
      const navDoc = new DOMParser().parseFromString(navXml, "application/xhtml+xml");
      navDoc.querySelectorAll("nav a, ol a").forEach((a) => {
        const href = (a as HTMLAnchorElement).getAttribute("href") || "";
        // Loại bỏ fragment (#...)
        const cleanHref = href.split("#")[0];
        const label = a.textContent?.trim() || "";
        if (cleanHref && label) {
          chapterTitles[cleanHref] = label;
          // Cũng map theo tên file
          const fileName = cleanHref.split("/").pop() || cleanHref;
          chapterTitles[fileName] = label;
        }
      });
    }
  }

  // Thử EPUB2 NCX
  if (Object.keys(chapterTitles).length === 0) {
    const ncxId = Array.from(opfDoc.querySelectorAll("manifest item")).find(
      (el) => el.getAttribute("media-type") === "application/x-dtbncx+xml"
    );
    if (ncxId) {
      const ncxHref = ncxId.getAttribute("href") || "";
      const ncxXml = await zip.file(opfDir + ncxHref)?.async("string");
      if (ncxXml) {
        const ncxDoc = new DOMParser().parseFromString(ncxXml, "application/xml");
        ncxDoc.querySelectorAll("navPoint").forEach((np) => {
          const label = np.querySelector("navLabel text")?.textContent?.trim() || "";
          const contentEl = np.querySelector("content");
          const src = contentEl?.getAttribute("src") || "";
          const cleanSrc = src.split("#")[0];
          if (cleanSrc && label) {
            chapterTitles[cleanSrc] = label;
            chapterTitles[cleanSrc.split("/").pop() || cleanSrc] = label;
          }
        });
      }
    }
  }

  onProgress(40);

  // 4. Parse từng spine item
  const parsedChapters: Chapter[] = [];
  const MAX_CHAPTERS = 200;
  const itemsCount = Math.min(spineIds.length, MAX_CHAPTERS);

  for (let i = 0; i < itemsCount; i++) {
    const idref = spineIds[i];
    const relHref = manifest[idref];
    if (!relHref) continue;

    const fullPath = opfDir + relHref;
    const fileContent = await zip.file(fullPath)?.async("string");
    if (!fileContent) continue;

    const doc = new DOMParser().parseFromString(
      fileContent,
      "application/xhtml+xml"
    );

    // Bỏ qua nếu parse error
    if (doc.querySelector("parsererror")) {
      const doc2 = new DOMParser().parseFromString(fileContent, "text/html");
      if (!doc2.body?.textContent?.trim()) continue;
    }

    // Lấy tiêu đề chương: ưu tiên TOC → h1/h2/h3 → fallback
    const fileName = relHref.split("/").pop() || relHref;
    let chapterTitle =
      chapterTitles[relHref] ||
      chapterTitles[fileName] ||
      doc.querySelector("h1, h2, h3, h4")?.textContent?.trim() ||
      "";

    // Trích xuất đoạn văn
    const rawParagraphs: Paragraph[] = [];
    let pIndex = 0;

    // Ưu tiên thẻ <p>
    const pEls = doc.querySelectorAll("p");
    if (pEls.length > 0) {
      pEls.forEach((el) => {
        const text = el.textContent?.trim() || "";
        if (text.length > 8) {
          rawParagraphs.push({ id: `${i}-${pIndex}`, text, index: pIndex++ });
        }
      });
    }

    // Fallback: div không có con là block
    if (rawParagraphs.length === 0) {
      doc.querySelectorAll("div").forEach((el) => {
        if (el.children.length === 0) {
          const text = el.textContent?.trim() || "";
          if (text.length > 8) {
            rawParagraphs.push({ id: `${i}-${pIndex}`, text, index: pIndex++ });
          }
        }
      });
    }

    // Fallback cuối: split theo newline từ body text
    if (rawParagraphs.length === 0) {
      const bodyText = doc.body?.textContent || "";
      bodyText.split(/\n+/).forEach((line) => {
        const trimmed = line.trim();
        if (trimmed.length > 10) {
          rawParagraphs.push({ id: `${i}-${pIndex}`, text: trimmed, index: pIndex++ });
        }
      });
    }

    if (rawParagraphs.length === 0) continue;

    if (!chapterTitle) {
      chapterTitle = `Phần ${parsedChapters.length + 1}`;
    }

    parsedChapters.push({
      id: idref || `chap-${i}`,
      title: chapterTitle,
      href: relHref,
      paragraphs: rawParagraphs,
    });

    onProgress(Math.floor(40 + (i / itemsCount) * 50));
  }

  if (parsedChapters.length === 0) {
    throw new Error("Không trích xuất được nội dung văn bản từ file EPUB này.");
  }

  return { title, creator, chapters: parsedChapters };
}
