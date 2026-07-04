// ── STATE ──────────────────────────────────────────────────────
let db = null;
let allBooks = [];
let fileFormats = {};      // bookId → [{format, name}]
let filtered = [];
let currentPage = 1;
const PAGE_SIZE = 48;
let currentFilter = 'all';
let currentTag = null;
let currentFormat = null;
let currentLang = null;
let currentPublisher = null;
let currentSort = 'title_asc';
let comments = {};

// Folder state
let libraryRoot = null;      // FileSystemDirectoryHandle (modern API)
let libraryFileMap = {};     // relative path (lowercase) → File object (fallback)
let folderMode = null;       // 'fsa' | 'input' | 'http' | null

// Server-backed library (khi trang này được phục vụ bởi tts_server.py Flask,
// server tự đọc thư mục Calibre trên đĩa nên KHÔNG cần người dùng chọn thủ
// công mỗi lần mở app — xem tryAutoLoadServerLibrary()).
let serverLibraryAvailable = false;

// ── INIT ──────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  initUpload();
  document.getElementById('folderInputHidden').addEventListener('change', onFolderInputChange);
  await tryAutoLoadServerLibrary();
});

// Thử tự động tải thư viện Calibre từ server (tts_server.py) — nếu trang này
// được mở qua localhost:3000/calibre-manager (Flask), server đã biết sẵn
// đường dẫn thư mục thư viện (mặc định hoặc đã lưu trước đó) và tự đọc
// metadata.db + phục vụ file sách, nên người dùng không cần chọn thư mục
// bằng tay như khi mở file calibre-manager.html độc lập (offline/file://).
async function tryAutoLoadServerLibrary() {
  let cfg;
  try {
    const res = await fetch('/api/calibre/config');
    if (!res.ok) return false;
    cfg = await res.json();
  } catch (e) {
    return false; // không chạy dưới server Flask (vd. mở trực tiếp bằng file://) -> dùng picker thủ công
  }

  serverLibraryAvailable = true;
  window.__calibreConfig = cfg;

  if (!cfg.valid) {
    showServerLibraryError(cfg.path);
    return false;
  }

  return await loadServerLibrary(cfg.path, /*isInitialLoad*/ true);
}

function showServerLibraryError(path) {
  const dropZone = document.getElementById('dropZone');
  if (!dropZone) return;
  const hint = document.createElement('p');
  hint.style.cssText = 'font-size:12px;color:#b5451f;margin-top:12px';
  hint.textContent = path
    ? `Không tìm thấy metadata.db trong "${path}". Nhấn nút trên để chọn lại thư mục thư viện Calibre.`
    : 'Chưa cấu hình thư mục thư viện Calibre trên server.';
  dropZone.appendChild(hint);
}

// Tải metadata.db trực tiếp từ server (không cần người dùng chọn file/thư mục)
async function loadServerLibrary(path, isInitialLoad = false) {
  document.getElementById('uploadZone').style.display = 'none';
  document.getElementById('appZone').style.display = 'flex';
  document.getElementById('loadingMain').style.display = 'flex';
  document.getElementById('loadingMain').innerHTML =
    `<div class="empty"><div class="empty-icon">📚</div><div>Đang tải thư viện${path ? ' "' + esc(path) + '"' : ''}...</div></div>`;
  document.getElementById('bookGrid').innerHTML = '';
  document.getElementById('pagination').innerHTML = '';

  try {
    const dbRes = await fetch('/api/calibre/metadata.db?_=' + Date.now(), { cache: 'no-store' });
    if (!dbRes.ok) throw new Error('Không tải được metadata.db từ server (HTTP ' + dbRes.status + ')');
    const buf = await dbRes.arrayBuffer();

    // reset state cũ (đổi thư mục thư viện giữa chừng)
    db = null; allBooks = []; fileFormats = {}; comments = {};
    folderMode = 'http';
    libraryRoot = null;
    libraryFileMap = {};

    const label = (path || '').split(/[\\/]/).filter(Boolean).pop() || path || 'Thư viện';
    onFolderSelected(label);
    await loadDbFromBuffer(buf);
    return true;
  } catch (err) {
    document.getElementById('loadingMain').innerHTML =
      `<div class="empty"><div class="empty-icon">⚠️</div><div>Không tải được thư viện: ${esc(err.message || '')}</div></div>`;
    if (isInitialLoad) {
      document.getElementById('appZone').style.display = 'none';
      document.getElementById('uploadZone').style.display = 'flex';
      showServerLibraryError(path);
    }
    return false;
  }
}

function initUpload() {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  });
  fileInput.addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); });
}

// ── LOAD DB FILE ──────────────────────────────────────────────
async function loadFile(file) {
  document.getElementById('uploadZone').style.display = 'none';
  document.getElementById('appZone').style.display = 'flex';
  document.getElementById('loadingMain').style.display = 'flex';
  document.getElementById('bookGrid').innerHTML = '';
  document.getElementById('pagination').innerHTML = '';

  try {
    const buf = await file.arrayBuffer();
    await loadDbFromBuffer(buf);
  } catch (err) {
    document.getElementById('loadingMain').innerHTML =
      `<div class="empty"><div class="empty-icon">⚠️</div><div>Không đọc được file: ${err.message}</div></div>`;
  }
}

// Khởi tạo sql.js và mở database Calibre từ một ArrayBuffer chứa nội dung
// metadata.db — dùng chung cho cả 2 nguồn: file người dùng chọn (File API)
// và file tải trực tiếp từ server (fetch /api/calibre/metadata.db).
async function loadDbFromBuffer(buf) {
  const SQL = await initSqlJs({
    wasmBinary: __b64ToUint8Array(__SQL_WASM_B64__)
  });
  db = new SQL.Database(new Uint8Array(buf));
  await loadData();
}

// ── LOAD DATA ────────────────────────────────────────────────
async function loadData() {
  // Comments
  const cmtRes = db.exec(`SELECT book, text FROM comments`);
  if (cmtRes.length) cmtRes[0].values.forEach(([id, text]) => { comments[id] = text; });

  // File formats per book
  const fmtRes = db.exec(`SELECT book, format, name FROM data ORDER BY book, format`);
  if (fmtRes.length) {
    fmtRes[0].values.forEach(([bookId, fmt, name]) => {
      if (!fileFormats[bookId]) fileFormats[bookId] = [];
      fileFormats[bookId].push({ format: fmt, name });
    });
  }

  // Main query.
  // LƯU Ý QUAN TRỌNG: trước đây câu này LEFT JOIN thẳng vào authors, tags,
  // data (formats) cùng lúc — vì đây đều là quan hệ 1-nhiều, JOIN nhiều bảng
  // 1-nhiều cùng lúc sẽ nhân chéo (cartesian) số dòng trước khi GROUP BY gộp
  // lại (VD: 5 tag × 3 định dạng = 15 dòng thô cho MỖI cuốn sách). Với thư
  // viện vài nghìn cuốn, mỗi cuốn nhiều tag/định dạng, tổng số dòng thô có
  // thể lên tới hàng trăm nghìn/hàng triệu — khiến sql.js (chạy đồng bộ,
  // chặn luồng chính của trình duyệt) mất rất lâu hoặc treo cứng tab ngay
  // từ lúc tải thư viện. Sửa lại bằng subquery GROUP_CONCAT độc lập cho từng
  // quan hệ 1-nhiều (mỗi subquery chỉ gộp trong phạm vi 1 bảng liên kết, độc
  // lập với các bảng khác) — không còn nhân chéo, số dòng ra đúng bằng số
  // sách.
  const res = db.exec(`
    SELECT b.id, b.title, b.author_sort,
           (SELECT GROUP_CONCAT(DISTINCT a.name)
              FROM books_authors_link bal JOIN authors a ON a.id = bal.author
             WHERE bal.book = b.id) as authors,
           (SELECT GROUP_CONCAT(DISTINCT t.name)
              FROM books_tags_link btl JOIN tags t ON t.id = btl.tag
             WHERE btl.book = b.id) as tags,
           b.pubdate, b.has_cover, b.path, b.series_index,
           (SELECT p.name FROM books_publishers_link bpl
              JOIN publishers p ON p.id = bpl.publisher
             WHERE bpl.book = b.id LIMIT 1) as publisher,
           (SELECT s.name FROM books_series_link bsl
              JOIN series s ON s.id = bsl.series
             WHERE bsl.book = b.id LIMIT 1) as series,
           (SELECT GROUP_CONCAT(DISTINCT d.format)
              FROM data d WHERE d.book = b.id) as formats,
           (SELECT r.rating FROM books_ratings_link brl
              JOIN ratings r ON r.id = brl.rating
             WHERE brl.book = b.id LIMIT 1) as rating,
           (SELECT l.lang_code FROM books_languages_link bll
              JOIN languages l ON l.id = bll.lang_code
             WHERE bll.book = b.id LIMIT 1) as lang
    FROM books b
    ORDER BY b.title COLLATE NOCASE ASC
  `);

  if (!res.length) { showEmpty('Không tìm thấy sách nào.'); return; }

  const cols = res[0].columns;
  allBooks = res[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    obj.formats_arr = obj.formats ? [...new Set(obj.formats.split(','))] : [];
    obj.tags_arr = obj.tags ? obj.tags.split(',') : [];
    obj.authors_arr = obj.authors ? obj.authors.split(',') : [];
    obj.year = obj.pubdate ? obj.pubdate.substring(0,4) : '';
    return obj;
  });

  buildSidebar();
  document.getElementById('searchWrap').style.display = 'flex';
  document.getElementById('viewBtns').style.display = 'flex';
  document.getElementById('totalCount').style.display = 'inline';
  document.getElementById('totalCount').textContent = `${allBooks.length} cuốn`;
  document.getElementById('badgeAll').textContent = allBooks.length;
  document.getElementById('badgeCover').textContent = allBooks.filter(b => b.has_cover).length;
  document.getElementById('badgeRated').textContent = allBooks.filter(b => b.rating).length;
  document.getElementById('folderIndicator').style.display = 'flex';

  document.getElementById('searchInput').addEventListener('input', debounce(() => {
    currentPage = 1; applyFilters();
  }, 220));

  document.getElementById('loadingMain').style.display = 'none';
  applyFilters();
}

// ── FOLDER PICKER ─────────────────────────────────────────────
async function pickFolder() {
  // Khi chạy dưới server Flask (tts_server.py): dùng hộp thoại chọn thư mục
  // GỐC của hệ điều hành (mở trên máy chạy server) thay vì trình duyệt, vì
  // server có thể đọc trực tiếp bất kỳ đường dẫn nào trên đĩa (không bị giới
  // hạn bởi quyền của File System Access API), và đường dẫn chọn được sẽ
  // được lưu lại để tự động tải ở lần mở app kế tiếp.
  if (serverLibraryAvailable) {
    const chosen = await browseServerFolder();
    if (chosen) await applyServerLibraryPath(chosen);
    return;
  }

  // Try modern File System Access API first
  if ('showDirectoryPicker' in window) {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      libraryRoot = handle;
      folderMode = 'fsa';
      await autoDetectAndLoad(handle.name);
      return;
    } catch(e) {
      if (e.name === 'AbortError') return; // user cancelled
      console.warn('FSA picker failed, falling back to <input webkitdirectory>', e);
    }
  }
  // Fallback: <input webkitdirectory>
  document.getElementById('folderInputHidden').click();
}

async function onFolderInputChange(e) {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  folderMode = 'input';
  libraryFileMap = {};
  // Build a map: relative path → File
  // The webkitRelativePath is like "CalibreLib/Author/Book (id)/file.epub"
  // We store from the second segment onward (skip root folder name)
  const rootName = files[0].webkitRelativePath.split('/')[0];
  files.forEach(f => {
    const rel = f.webkitRelativePath.slice(rootName.length + 1); // remove "RootFolder/"
    libraryFileMap[rel.toLowerCase()] = f;
  });

  // reset input so the same folder can be re-selected later
  e.target.value = '';

  // If a database is already loaded (user picked metadata.db manually first),
  // just attach the folder for cover/EPUB/PDF access — don't reload the DB.
  if (db) {
    onFolderSelected(rootName);
    return;
  }

  // Find metadata.db anywhere in the picked folder (prefer root-level)
  const dbEntry = Object.entries(libraryFileMap)
    .find(([rel]) => rel === 'metadata.db') ||
    Object.entries(libraryFileMap).find(([rel]) => rel.endsWith('/metadata.db'));

  if (!dbEntry) {
    alert('Không tìm thấy file metadata.db trong thư mục đã chọn. Hãy chắc chắn đây là thư mục gốc thư viện Calibre.');
    return;
  }
  onFolderSelected(rootName);
  await loadFile(dbEntry[1]);
}

// Recursively search a FileSystemDirectoryHandle (depth-limited) for metadata.db
async function findMetadataDbHandle(dirHandle, depth = 0) {
  // Check root level first (fast path — covers the vast majority of cases)
  try {
    const fh = await dirHandle.getFileHandle('metadata.db', { create: false });
    return fh;
  } catch (e) { /* not at this level, keep looking */ }

  if (depth >= 2) return null; // avoid scanning huge unrelated trees too deeply

  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'directory') {
      const found = await findMetadataDbHandle(handle, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// After a directory is selected via the File System Access API:
// locate metadata.db automatically and load it, with zero extra prompts.
async function autoDetectAndLoad(rootName) {
  // If a database is already loaded (e.g. user picked metadata.db manually first,
  // and is now just attaching the library folder for cover/EPUB/PDF access),
  // skip re-finding/re-loading metadata.db — just attach the folder.
  if (db) {
    onFolderSelected(rootName);
    return;
  }

  document.getElementById('uploadZone').style.display = 'none';
  document.getElementById('appZone').style.display = 'flex';
  document.getElementById('loadingMain').style.display = 'flex';
  document.getElementById('loadingMain').innerHTML =
    `<div class="empty"><div class="empty-icon">🔍</div><div>Đang tìm metadata.db trong "${esc(rootName)}"...</div></div>`;

  try {
    const dbHandle = await findMetadataDbHandle(libraryRoot);
    if (!dbHandle) {
      document.getElementById('loadingMain').innerHTML =
        `<div class="empty"><div class="empty-icon">⚠️</div><div>
          Không tìm thấy <strong>metadata.db</strong> trong thư mục "${esc(rootName)}".<br>
          Hãy chọn đúng thư mục gốc của thư viện Calibre.
        </div></div>`;
      return;
    }
    onFolderSelected(rootName);
    const dbFile = await dbHandle.getFile();
    await loadFile(dbFile);
  } catch (err) {
    document.getElementById('loadingMain').innerHTML =
      `<div class="empty"><div class="empty-icon">⚠️</div><div>Lỗi khi đọc thư mục: ${esc(err.message || '')}</div></div>`;
  }
}

// Mở hộp thoại chọn thư mục gốc (native, phía server) và trả về đường dẫn
// đã chọn, hoặc null nếu người dùng huỷ / có lỗi.
async function browseServerFolder() {
  try {
    const res = await fetch('/api/calibre/browse-folder', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) {
      alert(data.error || 'Không mở được hộp thoại chọn thư mục trên server.');
      return null;
    }
    if (data.cancelled || !data.path) return null;
    return data.path;
  } catch (e) {
    alert('Không kết nối được tới server để chọn thư mục: ' + (e.message || e));
    return null;
  }
}

// Lưu đường dẫn thư viện mới vào server rồi tải lại metadata.db từ đó.
async function applyServerLibraryPath(path) {
  try {
    const res = await fetch('/api/calibre/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const cfg = await res.json();
    window.__calibreConfig = cfg;
    if (!cfg.valid) {
      alert(`Không tìm thấy metadata.db trong "${path}". Hãy chắc chắn đây là thư mục gốc thư viện Calibre.`);
      return;
    }
    await loadServerLibrary(cfg.path, /*isInitialLoad*/ false);
  } catch (e) {
    alert('Lỗi khi lưu thư mục thư viện: ' + (e.message || e));
  }
}

function onFolderSelected(name) {
  document.getElementById('folderName').textContent = name;
  document.getElementById('folderBanner').style.display = 'none';
  document.getElementById('folderIndicator').style.display = 'flex';
  // Re-render current page so cover images + file buttons appear (no-op if books not loaded yet)
  if (allBooks.length) renderPage();
}

// ── GET FILE FROM FOLDER ──────────────────────────────────────
// Returns the raw File object for a file inside the Calibre library, or null
async function getFileObject(bookPath, fileName, format) {
  const ext = format.toLowerCase();
  const relPath = `${bookPath}/${fileName}.${ext}`;

  if (folderMode === 'http') {
    try {
      const res = await fetch('/api/calibre/file?rel=' + encodeURIComponent(relPath));
      if (!res.ok) return null;
      return await res.blob(); // Blob có .arrayBuffer(), dùng được như File
    } catch (e) { return null; }
  }

  if (folderMode === 'fsa' && libraryRoot) {
    try {
      const parts = relPath.split('/');
      let dir = libraryRoot;
      for (let i = 0; i < parts.length - 1; i++) {
        dir = await dir.getDirectoryHandle(parts[i], { create: false });
      }
      const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: false });
      return await fileHandle.getFile();
    } catch(e) { return null; }
  }

  if (folderMode === 'input') {
    const key = relPath.toLowerCase();
    return libraryFileMap[key] || null;
  }

  return null;
}

// Returns a URL for a file inside the Calibre library, or null.
// Ở chế độ 'http', trả thẳng URL server (không cần tải cả file vào bộ nhớ
// rồi tạo blob: URL) — dùng HEAD để kiểm tra file có tồn tại hay không.
async function getFileUrl(bookPath, fileName, format) {
  if (folderMode === 'http') {
    const relPath = `${bookPath}/${fileName}.${format.toLowerCase()}`;
    const url = '/api/calibre/file?rel=' + encodeURIComponent(relPath);
    try {
      const res = await fetch(url, { method: 'HEAD' });
      return res.ok ? url : null;
    } catch (e) { return null; }
  }
  const file = await getFileObject(bookPath, fileName, format);
  return file ? URL.createObjectURL(file) : null;
}

async function getCoverUrl(bookPath, hasCover) {
  if (!hasCover || !folderMode) return null;
  return await getFileUrl(bookPath, 'cover', 'jpg');
}

// Trả thẳng URL ảnh bìa ở chế độ 'http' KHÔNG kèm HEAD request kiểm tra
// trước (khác getFileUrl/getCoverUrl ở trên). Trước đây mỗi ảnh bìa phải
// làm 2 round-trip (1 HEAD kiểm tra tồn tại + 1 GET tải ảnh thật) — với 48
// bìa/trang tải cùng lúc, số request tăng gấp đôi không cần thiết và dễ làm
// nghẽn (đặc biệt khi thư viện nằm trên ổ mạng/OneDrive, mỗi request đều
// phải chờ hệ thống file trả lời). Vì has_cover đã cho biết ảnh có tồn tại
// hay không, ta có thể tải thẳng và chỉ cần xử lý lỗi qua <img onerror>.
function getCoverUrlFast(bookPath) {
  if (folderMode !== 'http') return null;
  return '/api/calibre/file?rel=' + encodeURIComponent(`${bookPath}/cover.jpg`);
}

// ── SIDEBAR ──────────────────────────────────────────────────
function buildSidebar() {
  const fmtMap = {};
  allBooks.forEach(b => b.formats_arr.forEach(f => { fmtMap[f] = (fmtMap[f]||0)+1; }));
  document.getElementById('formatList').innerHTML = Object.entries(fmtMap).sort((a,b)=>b[1]-a[1]).map(([f,c]) =>
    `<button class="sidebar-item" onclick="filterByFormat('${f}',this)">
      ${fmtIcon(f)} ${f} <span class="badge">${c}</span>
    </button>`).join('');

  const langMap = {};
  allBooks.forEach(b => { if (b.lang) langMap[b.lang] = (langMap[b.lang]||0)+1; });
  document.getElementById('langList').innerHTML = Object.entries(langMap).sort((a,b)=>b[1]-a[1]).map(([l,c]) =>
    `<button class="sidebar-item" onclick="filterByLang('${l}',this)">
      ${langFlag(l)} ${langName(l)} <span class="badge">${c}</span>
    </button>`).join('');

  const tagMap = {};
  allBooks.forEach(b => b.tags_arr.forEach(t => { if(t) tagMap[t] = (tagMap[t]||0)+1; }));
  document.getElementById('tagList').innerHTML = Object.entries(tagMap).sort((a,b)=>b[1]-a[1]).map(([t,c]) =>
    `<button class="sidebar-item" onclick="filterByTag('${escAttr(t)}',this)">
      🏷 ${esc(t)} <span class="badge">${c}</span>
    </button>`).join('');

  const pubMap = {};
  allBooks.forEach(b => { if (b.publisher) pubMap[b.publisher] = (pubMap[b.publisher]||0)+1; });
  document.getElementById('publisherList').innerHTML = Object.entries(pubMap).sort((a,b)=>b[1]-a[1]).map(([p,c]) =>
    `<button class="sidebar-item" onclick="filterByPublisher('${escAttr(p)}',this)">
      🏢 ${esc(p)} <span class="badge">${c}</span>
    </button>`).join('');
}

// ── FILTERS ──────────────────────────────────────────────────
function clearSidebarActive() {
  document.querySelectorAll('#sidebar .sidebar-item').forEach(el => el.classList.remove('active'));
}
function filterBy(type, el) {
  clearSidebarActive(); el.classList.add('active');
  currentFilter = type; currentTag = null; currentFormat = null; currentLang = null; currentPublisher = null;
  currentPage = 1; applyFilters();
}
function filterByFormat(fmt, el) {
  clearSidebarActive(); el.classList.add('active');
  currentFilter = 'format'; currentFormat = fmt;
  currentTag = null; currentLang = null; currentPublisher = null;
  currentPage = 1; applyFilters();
}
function filterByLang(lang, el) {
  clearSidebarActive(); el.classList.add('active');
  currentFilter = 'lang'; currentLang = lang;
  currentTag = null; currentFormat = null; currentPublisher = null;
  currentPage = 1; applyFilters();
}
function filterByTag(tag, el) {
  clearSidebarActive(); el.classList.add('active');
  currentFilter = 'tag'; currentTag = tag;
  currentFormat = null; currentLang = null; currentPublisher = null;
  currentPage = 1; applyFilters();
}
function filterByPublisher(pub, el) {
  clearSidebarActive(); el.classList.add('active');
  currentFilter = 'publisher'; currentPublisher = pub;
  currentTag = null; currentFormat = null; currentLang = null;
  currentPage = 1; applyFilters();
}
function applySort() {
  currentSort = document.getElementById('sortSelect').value;
  currentPage = 1; applyFilters();
}

function applyFilters() {
  const q = document.getElementById('searchInput').value.toLowerCase().trim();
  filtered = allBooks.filter(b => {
    if (currentFilter === 'has_cover' && !b.has_cover) return false;
    if (currentFilter === 'rated' && !b.rating) return false;
    if (currentFilter === 'format' && !b.formats_arr.includes(currentFormat)) return false;
    if (currentFilter === 'lang' && b.lang !== currentLang) return false;
    if (currentFilter === 'tag' && !b.tags_arr.includes(currentTag)) return false;
    if (currentFilter === 'publisher' && b.publisher !== currentPublisher) return false;
    if (q) {
      const haystack = [b.title, b.authors, b.tags, b.publisher, b.series].join(' ').toLowerCase();
      return haystack.includes(q);
    }
    return true;
  });

  filtered.sort((a, b) => {
    switch (currentSort) {
      case 'title_asc':   return (a.title||'').localeCompare(b.title||'', 'vi');
      case 'title_desc':  return (b.title||'').localeCompare(a.title||'', 'vi');
      case 'author_asc':  return (a.author_sort||'').localeCompare(b.author_sort||'', 'vi');
      case 'date_desc':   return (b.pubdate||'').localeCompare(a.pubdate||'');
      case 'date_asc':    return (a.pubdate||'').localeCompare(b.pubdate||'');
      case 'rating_desc': return (b.rating||0) - (a.rating||0);
    }
    return 0;
  });

  const count = filtered.length;
  document.getElementById('resultCount').innerHTML =
    `Hiển thị <strong>${Math.min(PAGE_SIZE*(currentPage), count)}</strong> / <strong>${count}</strong> cuốn`;
  renderPage();
  renderPagination();
}

// ── RENDER ────────────────────────────────────────────────────
function renderPage() {
  const start = (currentPage - 1) * PAGE_SIZE;
  const page = filtered.slice(start, start + PAGE_SIZE);
  const grid = document.getElementById('bookGrid');

  if (!page.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">
      <div class="empty-icon">🔍</div><div>Không tìm thấy sách nào</div></div>`;
    return;
  }

  grid.innerHTML = page.map(b => renderCard(b)).join('');

  // Async: load cover images if folder selected (theo từng đợt nhỏ, xem
  // ghi chú ở loadCoversInBatches)
  if (folderMode) {
    loadCoversInBatches(page);
  }
}

function renderCard(b) {
  const hue = b.id % 8;
  const rating = b.rating ? '★'.repeat(Math.round(b.rating/2)) : '';
  const formatBadges = b.formats_arr.map(f =>
    `<span class="fmt-badge ${f.toLowerCase()}">${f}</span>`).join('');

  return `<div class="book-card" onclick="openModal(${b.id})">
    <div class="cover-wrap">
      <div class="cover-placeholder" data-hue="${hue}" id="cover-${b.id}">
        <div class="cover-placeholder-icon">📖</div>
        <div class="cover-placeholder-title">${esc(b.title)}</div>
      </div>
      <div class="format-badges">${formatBadges}</div>
    </div>
    <div class="card-info">
      <div class="card-title">${esc(b.title)}</div>
      <div class="card-author">${esc(b.authors || b.author_sort || '')}</div>
      ${rating ? `<div class="card-rating">${rating}</div>` : ''}
    </div>
  </div>`;
}

function loadCardCover(b) {
  const el = document.getElementById(`cover-${b.id}`);
  if (!el) return;

  let url = null;
  if (folderMode === 'http') {
    url = getCoverUrlFast(b.path); // không cần await, không HEAD request
  } else {
    // Chế độ chọn thư mục thủ công (fsa/input): vẫn cần đọc File object,
    // giữ nguyên đường cũ.
    getCoverUrl(b.path, true).then((u) => { if (u) applyCoverImg(el, u); });
    return;
  }
  if (!url) return;
  applyCoverImg(el, url);
}

function applyCoverImg(el, url) {
  const img = document.createElement('img');
  img.src = url;
  img.onload = () => { el.replaceWith(img); };
  img.onerror = () => { /* giữ nguyên placeholder nếu không tải được bìa */ };
}

// Tải bìa sách theo từng đợt nhỏ thay vì bắn hết N ảnh của cả trang cùng
// lúc — tránh làm nghẽn khi thư viện lớn hoặc nằm trên ổ mạng/OneDrive
// chậm, việc khiến nhiều request cùng "kẹt" một lúc từng làm cả bìa sách
// KHÔNG hiện ra được và các thao tác khác (mở chi tiết sách) bị "đơ" theo do
// trình duyệt giới hạn số kết nối đồng thời tới cùng 1 địa chỉ.
function loadCoversInBatches(books, batchSize = 8) {
  let i = 0;
  function next() {
    const batch = books.slice(i, i + batchSize);
    if (!batch.length) return;
    batch.forEach((b) => { if (b.has_cover) loadCardCover(b); });
    i += batchSize;
    if (i < books.length) setTimeout(next, 60);
  }
  next();
}

// ── PAGINATION ────────────────────────────────────────────────
function renderPagination() {
  const total = Math.ceil(filtered.length / PAGE_SIZE);
  if (total <= 1) { document.getElementById('pagination').innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="goPage(${currentPage-1})" ${currentPage===1?'disabled':''}>‹</button>`;
  const range = pageRange(currentPage, total);
  let prev = null;
  range.forEach(p => {
    if (prev !== null && p - prev > 1) html += `<span class="page-btn" style="opacity:.4;cursor:default">…</span>`;
    html += `<button class="page-btn ${p===currentPage?'active':''}" onclick="goPage(${p})">${p}</button>`;
    prev = p;
  });
  html += `<button class="page-btn" onclick="goPage(${currentPage+1})" ${currentPage===total?'disabled':''}>›</button>`;
  document.getElementById('pagination').innerHTML = html;
}

function pageRange(cur, total) {
  const delta = 2;
  const range = new Set([1, total]);
  for (let i = Math.max(2, cur-delta); i <= Math.min(total-1, cur+delta); i++) range.add(i);
  return [...range].sort((a,b)=>a-b);
}

function goPage(p) {
  const total = Math.ceil(filtered.length / PAGE_SIZE);
  if (p < 1 || p > total) return;
  currentPage = p; renderPage(); renderPagination();
  document.getElementById('bookGrid').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── MODAL ────────────────────────────────────────────────────
async function openModal(bookId) {
  const book = allBooks.find(b => b.id === bookId);
  if (!book) return;

  // Cover
  const hue = book.id % 8;
  let coverHtml = `<div class="cover-placeholder" data-hue="${hue}" style="width:100%;height:100%">
    <div class="cover-placeholder-icon" style="font-size:40px">📖</div>
  </div>`;
  document.getElementById('modalCover').innerHTML = coverHtml;

  // Load real cover async
  if (folderMode && book.has_cover) {
    getCoverUrl(book.path, true).then(url => {
      if (!url) return;
      const img = document.createElement('img');
      img.src = url;
      img.style.cssText = 'width:100%;height:100%;object-fit:contain';
      const coverEl = document.getElementById('modalCover');
      if (coverEl) coverEl.innerHTML = '';
      if (coverEl) coverEl.appendChild(img);
    });
  }

  document.getElementById('modalTitle').textContent = book.title;
  document.getElementById('modalAuthor').textContent = book.authors || book.author_sort || '';

  // Format pills
  document.getElementById('modalFormats').innerHTML = book.formats_arr.map(f =>
    `<span class="meta-pill format">${fmtIcon(f)} ${f}</span>`).join('');

  // Tags
  document.getElementById('modalTags').innerHTML = book.tags_arr.filter(Boolean).map(t =>
    `<span class="meta-pill">${esc(t)}</span>`).join('');

  // File action buttons
  renderFileActions(book);

  // Stats
  let statsHtml = '';
  if (book.year && book.year > '1900')
    statsHtml += `<div class="stat-box"><div class="stat-val">${book.year}</div><div class="stat-lbl">Năm XB</div></div>`;
  if (book.rating)
    statsHtml += `<div class="stat-box"><div class="stat-val">${(book.rating/2).toFixed(1)}★</div><div class="stat-lbl">Đánh giá</div></div>`;
  if (book.publisher)
    statsHtml += `<div class="stat-box"><div class="stat-val" style="font-size:11px;line-height:1.3">${esc(book.publisher)}</div><div class="stat-lbl">NXB</div></div>`;
  if (book.series)
    statsHtml += `<div class="stat-box"><div class="stat-val" style="font-size:11px;line-height:1.3">${esc(book.series)}</div><div class="stat-lbl">Bộ sách</div></div>`;
  if (book.lang)
    statsHtml += `<div class="stat-box"><div class="stat-val" style="font-size:18px">${langFlag(book.lang)}</div><div class="stat-lbl">${langName(book.lang)}</div></div>`;
  document.getElementById('modalStats').innerHTML = statsHtml;

  // Description
  const desc = comments[book.id];
  document.getElementById('modalBody').innerHTML = desc
    ? `<h3>Giới thiệu sách</h3><div class="modal-desc">${desc}</div>` : '';

  document.getElementById('modalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function renderFileActions(book) {
  const container = document.getElementById('fileActions');
  const formats = fileFormats[book.id] || [];

  if (!folderMode) {
    container.innerHTML = `
      <div class="no-folder-hint">
        📁 <span>Chọn thư mục Calibre để mở file sách —
        <a onclick="closeModalDirect();pickFolder()">chọn ngay</a></span>
      </div>`;
    return;
  }

  if (!formats.length) {
    container.innerHTML = `<div class="no-folder-hint">⚠️ Không có file nào cho cuốn sách này</div>`;
    return;
  }

  container.innerHTML = `
    <div class="file-actions-label">Mở file</div>
    <div class="file-btns" id="fileBtns-${book.id}">
      ${formats.map(f => `
        <button class="file-btn disabled" id="fbtn-${book.id}-${f.format}"
          onclick="openBookFile(${book.id},'${escAttr(book.path)}','${escAttr(f.name)}','${f.format}')">
          ${fmtIcon(f.format)} ${f.format}
        </button>`).join('')}
    </div>`;

  // Check which files actually exist
  formats.forEach(async f => {
    const url = await getFileUrl(book.path, f.name, f.format);
    const btn = document.getElementById(`fbtn-${book.id}-${f.format}`);
    if (!btn) return;
    if (url) {
      btn.classList.remove('disabled');
      btn.classList.add('open');
      btn.dataset.url = url;
    } else {
      btn.title = 'Không tìm thấy file trong thư mục đã chọn';
    }
  });
}

async function openBookFile(bookId, bookPath, fileName, format) {
  const btn = document.getElementById(`fbtn-${bookId}-${format}`);
  if (!btn || btn.classList.contains('disabled')) return;

  const book = allBooks.find(b => b.id === bookId);
  const niceTitle = book ? book.title : fileName;

  // EPUB / PDF need the raw file bytes (ArrayBuffer), not a blob: URL,
  // because epub.js/pdf.js try to XHR-fetch the URL otherwise, which fails on file://.
  if (format === 'EPUB' || format === 'PDF') {
    const fileObj = await getFileObject(bookPath, fileName, format);
    if (!fileObj) { alert('Không tìm thấy file. Hãy kiểm tra lại thư mục Calibre.'); return; }
    const buf = await fileObj.arrayBuffer();
    if (format === 'EPUB') openEpubReader(buf, niceTitle, fileObj);
    else openPdfReader(buf, niceTitle, fileObj);
    return;
  }

  const url = btn.dataset.url || await getFileUrl(bookPath, fileName, format);
  if (!url) { alert('Không tìm thấy file. Hãy kiểm tra lại thư mục Calibre.'); return; }

  const audioFmts = ['MP3','M4B','AAC','OGG','FLAC'];
  if (audioFmts.includes(format)) {
    openAudioPlayer(url, niceTitle, format);
    return;
  }
  // Other formats: still download, but with a proper filename
  downloadAs(url, niceTitle, format);
}

// Force-download a blob URL with a human-readable filename
function downloadAs(url, title, format) {
  const safeName = sanitizeFilename(title) + '.' + format.toLowerCase();
  const a = document.createElement('a');
  a.href = url;
  a.download = safeName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Trigger a download directly from a File object (used by EPUB/PDF reader's download button)
function downloadFileObject(fileObj, title, format) {
  const url = URL.createObjectURL(fileObj);
  downloadAs(url, title, format);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function sanitizeFilename(name) {
  return (name || 'sach').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
}

// Mini audio player
function openAudioPlayer(url, name, format) {
  const existing = document.getElementById('audioPlayerBar');
  if (existing) existing.remove();

  const bar = document.createElement('div');
  bar.id = 'audioPlayerBar';
  bar.style.cssText = `
    position:fixed;bottom:0;left:0;right:0;z-index:999;
    background:var(--ink);color:white;
    padding:10px 20px;display:flex;align-items:center;gap:12px;
    box-shadow:0 -4px 20px rgba(0,0,0,.3);
  `;
  bar.innerHTML = `
    <span style="font-size:18px">${fmtIcon(format)}</span>
    <div style="flex:1;min-width:0">
      <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</div>
      <audio controls autoplay style="width:100%;height:32px;margin-top:4px" src="${url}"></audio>
    </div>
    <button onclick="downloadAs('${url}', '${escAttr(name)}', '${format}')" title="Tải xuống" style="background:none;border:none;color:rgba(255,255,255,.6);font-size:16px;cursor:pointer;padding:4px">⬇</button>
    <button onclick="this.parentElement.remove()" style="background:none;border:none;color:rgba(255,255,255,.6);font-size:18px;cursor:pointer;padding:4px">✕</button>
  `;
  document.body.appendChild(bar);
}

function closeModal(e) {
  if (e.target === document.getElementById('modalOverlay')) closeModalDirect();
}
function closeModalDirect() {
  document.getElementById('modalOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

// ── READER: shared open/close ──────────────────────────────────
let currentEpubBook = null;
let currentEpubRendition = null;
let currentPdfDoc = null;
let currentPdfZoom = 1.2;

// File gốc (đối tượng File/Blob thật) + tiêu đề của cuốn EPUB đang mở trong
// reader — lưu lại để nút "Tạo Audiobook" có thể gửi nguyên cuốn sách này
// sang trang /epub2audiobook mà không cần người dùng phải tải file lại lần
// nữa (xem sendEpubToAudiobook() bên dưới).
let currentEpubFileObj = null;
let currentEpubTitle = '';

function openReader(title, fileObj, downloadName) {
  closeModalDirect();
  document.getElementById('readerTitle').textContent = title;
  document.getElementById('readerOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  const dlBtn = document.getElementById('readerDownloadBtn');
  dlBtn.onclick = () => downloadFileObject(fileObj, downloadName.replace(/\.[^.]+$/, ''), downloadName.split('.').pop());
}

function closeReader() {
  document.getElementById('readerOverlay').classList.remove('open');
  document.getElementById('readerOverlay').removeAttribute('data-theme');
  document.body.style.overflow = '';
  raShutdown(); // dừng & dọn dẹp Read Aloud nếu đang mở
  musicShutdown(); // dừng & dọn dẹp nhạc nền nếu đang mở
  document.getElementById('readerBody').innerHTML = '';
  document.getElementById('readerTools').innerHTML = '';
  document.removeEventListener('keydown', epubKeyHandler);
  currentEpubBook = null;
  currentEpubRendition = null;
  currentPdfDoc = null;
  currentEpubFileObj = null;
  currentEpubTitle = '';
  epubToc = [];
}

// ── EPUB READER (epub.js) ──────────────────────────────────────
function epubKeyHandler(e) {
  if (!currentEpubRendition) return;
  if (e.key === 'ArrowLeft') epubNav('prev');
  if (e.key === 'ArrowRight') epubNav('next');
}

// Điều hướng trang/chương EPUB — dừng Read Aloud trước nếu đang phát,
// để tránh đọc lệch nội dung khi người dùng tự lật trang bằng tay.
function epubNav(dir) {
  if (!currentEpubRendition) return;
  if (RA.playing || RA.loading) raStopAll();
  if (dir === 'prev') currentEpubRendition.prev();
  else currentEpubRendition.next();
}

function openEpubReader(arrayBuffer, title, fileObj) {
  openReader(title, fileObj, sanitizeFilename(title) + '.epub');
  currentEpubFileObj = fileObj || null;
  currentEpubTitle = title || '';
  const body = document.getElementById('readerBody');
  body.innerHTML = `
    <div class="epub-layout" id="epubLayout">
      <aside class="epub-toc-panel" id="epubTocPanel">
        <div class="epub-toc-header">
          <span>📑 Mục lục</span>
          <button class="epub-toc-close" onclick="epubToggleToc(false)" title="Đóng mục lục">✕</button>
        </div>
        <div class="epub-toc-list" id="epubTocList">
          <div class="epub-toc-empty">Đang tải mục lục…</div>
        </div>
      </aside>
      <div class="epub-viewer-wrap">
        <div id="epubViewer"></div>
        <button class="epub-nav-btn prev" onclick="epubNav('prev')">‹</button>
        <button class="epub-nav-btn next" onclick="epubNav('next')">›</button>
        <div class="reader-loading" id="epubLoading">📖 <span>Đang tải sách...</span></div>
      </div>
    </div>`;
  document.getElementById('readerTools').innerHTML = `
    <button class="rt-toggle-btn" id="tocToggleBtn" onclick="epubToggleToc()" title="Ẩn/hiện danh sách chương">📑 Mục lục</button>
    <button class="rt-toggle-btn" id="musicToggleBtn" onclick="musicTogglePanel()" title="Nhạc nền">🎵 Nhạc nền</button>
    <button onclick="epubFontSize(-1)" title="Giảm cỡ chữ">A−</button>
    <button onclick="epubFontSize(1)" title="Tăng cỡ chữ">A+</button>
    <button class="rt-toggle-btn" id="themeToggleBtn" onclick="themeTogglePanel()" title="Giao diện đọc sách">🎨 Giao diện</button>
    <button class="ra-toggle-btn" id="raToggleBtn" onclick="raTogglePanel()" title="Đọc to đoạn văn bằng giọng nói">🔊 Đọc to</button>
    <button class="rt-toggle-btn" id="toAudiobookBtn" onclick="sendEpubToAudiobook()" title="Chuyển cuốn sách này sang trang Tạo Audiobook (xuất file MP3)">🎧 Tạo Audiobook</button>`;

  raReset(); // reset state Read Aloud cho sách mới
  epubToc = [];

  // Pass the raw ArrayBuffer directly so epub.js parses it via JSZip in-memory,
  // instead of trying to XHR-fetch a URL (which fails on file://).
  currentEpubBook = ePub(arrayBuffer);
  currentEpubRendition = currentEpubBook.renderTo('epubViewer', {
    width: '100%', height: '100%', spread: 'auto'
  });

  epubRegisterThemes();
  epubApplySavedTheme();

  // Hook chạy mỗi khi epub.js render nội dung 1 section vào iframe — dùng để
  // dò các đoạn văn (<p>) và gắn khả năng bấm-vào-để-đọc + tô sáng khi đang đọc.
  currentEpubRendition.hooks.content.register(raOnContentLoaded);

  currentEpubRendition.display().then(() => {
    const loading = document.getElementById('epubLoading');
    if (loading) loading.remove();
  }).catch(err => {
    document.getElementById('epubViewer').innerHTML =
      `<div class="reader-loading">⚠️ Không đọc được file EPUB: ${esc(err.message || '')}</div>`;
  });

  // Cập nhật mục đang được tô sáng trong danh sách chương mỗi khi lật trang.
  currentEpubRendition.on('relocated', (loc) => {
    if (loc && loc.start) epubHighlightTocItem(loc.start.href);
  });

  epubLoadToc();
  document.addEventListener('keydown', epubKeyHandler);
}

let epubFontPct = 100;
function epubFontSize(delta) {
  if (!currentEpubRendition) return;
  epubFontPct = Math.min(180, Math.max(70, epubFontPct + delta * 10));
  currentEpubRendition.themes.fontSize(epubFontPct + '%');
}

// ── CHUYỂN SÁCH SANG TRANG "TẠO AUDIOBOOK" ──────────────────────────────
// Khi bấm nút "🎧 Tạo Audiobook" trong lúc đang đọc 1 cuốn EPUB ở Calibre
// Manager, ta lưu tạm chính file EPUB đang mở (đối tượng File/Blob thật,
// không phải chỉ đường dẫn) vào IndexedDB — vì trang /epub2audiobook là một
// trang riêng biệt (multi-page app), không thể truyền thẳng biến JS qua
// bằng điều hướng URL. Trang /epub2audiobook khi mở lên sẽ tự đọc lại dữ
// liệu này và nạp sách vào ngay, không bắt người dùng phải chọn lại file.
//
// Dùng IndexedDB (thay vì localStorage/sessionStorage) vì có thể lưu trực
// tiếp đối tượng Blob nhị phân với sách dung lượng lớn mà không cần mã hoá
// base64 (vốn tốn gấp ~1.3 lần bộ nhớ và có giới hạn dung lượng rất nhỏ ở
// sessionStorage). Cách này hoạt động giống hệt nhau dù chạy trên trình
// duyệt thường hay trong cửa sổ desktop (.exe, dùng WebView2/Edge) vì
// IndexedDB là API chuẩn của trình duyệt, không phụ thuộc server.
const EPUB_BRIDGE_DB_NAME = 'epub_reader_bridge';
const EPUB_BRIDGE_STORE = 'transfer';
const EPUB_BRIDGE_KEY = 'pending_audiobook';

function epubBridgeOpenDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('Trình duyệt không hỗ trợ IndexedDB')); return; }
    const req = indexedDB.open(EPUB_BRIDGE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(EPUB_BRIDGE_STORE)) {
        req.result.createObjectStore(EPUB_BRIDGE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Không mở được IndexedDB'));
  });
}

async function epubBridgeSave(payload) {
  const idb = await epubBridgeOpenDb();
  await new Promise((resolve, reject) => {
    const tx = idb.transaction(EPUB_BRIDGE_STORE, 'readwrite');
    tx.objectStore(EPUB_BRIDGE_STORE).put(payload, EPUB_BRIDGE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  idb.close();
}

async function sendEpubToAudiobook() {
  if (!currentEpubFileObj) {
    alert('Không tìm thấy dữ liệu file EPUB để chuyển sang trang Tạo Audiobook. Hãy mở lại cuốn sách rồi thử lại.');
    return;
  }
  const btn = document.getElementById('toAudiobookBtn');
  const originalLabel = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Đang chuyển...'; }
  try {
    await epubBridgeSave({
      title: currentEpubTitle || 'Sách',
      blob: currentEpubFileObj,
      ts: Date.now(),
    });
    window.location.href = '/epub2audiobook?from=calibre';
  } catch (e) {
    alert('Không chuyển được sách sang trang Tạo Audiobook: ' + (e && e.message ? e.message : e));
    if (btn) { btn.disabled = false; btn.innerHTML = originalLabel; }
  }
}

// ── MỤC LỤC / DANH SÁCH CHƯƠNG (ẩn/hiện bên trái, kiểu waka.vn) ─────────
let epubToc = [];

async function epubLoadToc() {
  if (!currentEpubBook) return;
  try {
    await currentEpubBook.loaded.navigation;
    epubToc = (currentEpubBook.navigation && currentEpubBook.navigation.toc) || [];
  } catch (e) {
    epubToc = [];
  }
  const list = document.getElementById('epubTocList');
  if (!list) return;
  if (!epubToc.length) {
    list.innerHTML = '<div class="epub-toc-empty">Sách này không có mục lục</div>';
    return;
  }
  list.innerHTML = epubRenderTocItems(epubToc, 0);
}

function epubRenderTocItems(items, level) {
  return items.map(item => {
    const label = esc((item.label || '').trim() || '(Không tên)');
    const sub = (item.subitems && item.subitems.length)
      ? epubRenderTocItems(item.subitems, level + 1) : '';
    return `
      <div class="epub-toc-item" data-href="${escAttr(item.href || '')}"
           style="padding-left:${14 + level * 16}px"
           onclick="epubGoToChapter('${escAttr(item.href || '')}')">${label}</div>
      ${sub}`;
  }).join('');
}

function epubGoToChapter(href) {
  if (!currentEpubRendition || !href) return;
  if (RA.playing || RA.loading) raStopAll();

  // Một số EPUB có mục lục (toc/ncx) ghi href khác đường dẫn so với spine
  // thực tế (ví dụ lệch thư mục, có/không dấu "./", khác cách mã hoá %20...),
  // khiến epub.js không khớp được đúng chương và display() không nhảy trang
  // (âm thầm lỗi, không báo gì). Ta dò lại href đúng theo spine trước khi hiển thị.
  const target = epubResolveTocHref(href);
  currentEpubRendition.display(target).catch(err => {
    console.warn('epubGoToChapter: không hiển thị được', target, err);
  });

  epubHighlightTocItem(href);
  // Trên màn hình nhỏ, đóng panel lại sau khi chọn chương cho đỡ che nội dung.
  if (window.innerWidth < 820) epubToggleToc(false);
}

// Dò tìm href chính xác trong spine của sách ứng với 1 mục trong mục lục.
// Thử lần lượt: href gốc, decode/encode URI, bỏ "./" ở đầu, và cuối cùng là
// so khớp theo TÊN FILE (bỏ qua thư mục) — cách này cứu được phần lớn các
// EPUB có mục lục trỏ sai thư mục so với spine thật.
function epubResolveTocHref(href) {
  if (!currentEpubBook || !currentEpubBook.spine || !href) return href;
  const hashIdx = href.indexOf('#');
  const rawPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const hash = hashIdx >= 0 ? href.slice(hashIdx + 1) : '';

  const candidates = [rawPath];
  try { candidates.push(decodeURIComponent(rawPath)); } catch (e) {}
  try { candidates.push(encodeURI(rawPath)); } catch (e) {}
  candidates.push(rawPath.replace(/^\.?\//, ''));

  for (const candidate of candidates) {
    if (!candidate) continue;
    let section = null;
    try { section = currentEpubBook.spine.get(candidate); } catch (e) { section = null; }
    if (section) return hash ? `${section.href}#${hash}` : section.href;
  }

  // Không khớp theo đường dẫn — thử khớp theo tên file, bỏ qua thư mục chứa.
  const filename = rawPath.split('/').pop();
  const items = (currentEpubBook.spine && currentEpubBook.spine.spineItems) || [];
  const found = filename && items.find(item => item.href && item.href.split('/').pop() === filename);
  if (found) return hash ? `${found.href}#${hash}` : found.href;

  return href; // đành trả về href gốc nếu không dò được gì khớp hơn
}

function epubHighlightTocItem(href) {
  const list = document.getElementById('epubTocList');
  if (!list || !href) return;
  const clean = href.split('#')[0];
  list.querySelectorAll('.epub-toc-item').forEach(el => {
    const itemHref = (el.dataset.href || '').split('#')[0];
    el.classList.toggle('active', !!itemHref && (itemHref === clean || href.endsWith(itemHref)));
  });
  const active = list.querySelector('.epub-toc-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function epubToggleToc(force) {
  const layout = document.getElementById('epubLayout');
  const btn = document.getElementById('tocToggleBtn');
  if (!layout) return;
  const show = typeof force === 'boolean' ? force : !layout.classList.contains('toc-open');
  layout.classList.toggle('toc-open', show);
  if (btn) btn.classList.toggle('active', show);
  // epub.js cần được báo resize lại vì bề rộng vùng đọc vừa thay đổi do panel
  // mục lục vừa đóng/mở (nếu không, cột chữ có thể lệch tới khi resize cửa sổ).
  setTimeout(() => { if (currentEpubRendition) currentEpubRendition.resize(); }, 260);
}

// ── GIAO DIỆN / THEME TRANG ĐỌC SÁCH ────────────────────────────────────
const EPUB_THEMES = {
  sepia: { name: '📜 Be ấm',      bg: '#f7f3ed', text: '#1a1410', link: '#8b4513' },
  light: { name: '☀️ Sáng',       bg: '#ffffff', text: '#1c1c1c', link: '#2563eb' },
  green: { name: '🌿 Xanh nhẹ',   bg: '#e7f2e4', text: '#1f2b1c', link: '#1e6b3a' },
  gray:  { name: '🌥 Xám dịu',    bg: '#e4e4e4', text: '#242424', link: '#3b5bdb' },
  dark:  { name: '🌙 Tối',        bg: '#232323', text: '#dcdcdc', link: '#8ab4f8' },
  black: { name: '⚫ Đen AMOLED', bg: '#000000', text: '#c9c9c9', link: '#8ab4f8' },
};

function epubRegisterThemes() {
  if (!currentEpubRendition) return;
  Object.keys(EPUB_THEMES).forEach(key => {
    const t = EPUB_THEMES[key];
    currentEpubRendition.themes.register(key, {
      'body': { 'background': t.bg + ' !important', 'color': t.text + ' !important' },
      'p, div, span, li, td, h1, h2, h3, h4, h5, h6': { 'color': t.text + ' !important' },
      'a, a:visited': { 'color': t.link + ' !important' },
    });
  });
}

function epubApplySavedTheme() {
  epubSetTheme(localStorage.getItem('epub_theme') || 'sepia');
}

function epubSetTheme(key) {
  if (!EPUB_THEMES[key]) key = 'sepia';
  if (currentEpubRendition) currentEpubRendition.themes.select(key);
  const overlay = document.getElementById('readerOverlay');
  if (overlay) overlay.setAttribute('data-theme', key);
  localStorage.setItem('epub_theme', key);
  document.querySelectorAll('.theme-swatch').forEach(el => {
    el.classList.toggle('active', el.dataset.theme === key);
  });
}

function themeTogglePanel(force) {
  let panel = document.getElementById('themePanel');
  const btn = document.getElementById('themeToggleBtn');
  const readerBody = document.getElementById('readerBody');
  const show = typeof force === 'boolean' ? force : !panel;
  if (!show) {
    if (panel) panel.remove();
    if (btn) btn.classList.remove('active');
    return;
  }
  if (panel || !readerBody) return;
  musicTogglePanel(false); // tránh 2 panel nổi đè lên nhau
  const current = localStorage.getItem('epub_theme') || 'sepia';
  panel = document.createElement('div');
  panel.id = 'themePanel';
  panel.className = 'floating-panel theme-panel';
  panel.innerHTML = `
    <div class="floating-panel-header">
      <span>🎨 Giao diện đọc sách</span>
      <button class="floating-panel-close" onclick="themeTogglePanel(false)">✕</button>
    </div>
    <div class="theme-swatch-grid">
      ${Object.keys(EPUB_THEMES).map(key => {
        const t = EPUB_THEMES[key];
        return `<button class="theme-swatch${key === current ? ' active' : ''}" data-theme="${key}"
          style="background:${t.bg};color:${t.text}" onclick="epubSetTheme('${key}')">${esc(t.name)}</button>`;
      }).join('')}
    </div>`;
  readerBody.appendChild(panel);
  if (btn) btn.classList.add('active');
}

// ── NHẠC NỀN (Background music từ link YouTube) ─────────────────────────
// Danh sách link được lưu lâu dài ở server (music_link.json) qua API
// GET/POST /api/music-links — panel tự tải ra lúc mở, và lưu lại ngay mỗi
// khi thêm/xoá một link.
const MUSIC = {
  links: [],
  loaded: false,
  playingId: null,
  player: null,       // instance YT.Player
  volume: parseInt(localStorage.getItem('music_volume') || '60', 10),
};

function musicShutdown() {
  musicTogglePanel(false);
  if (MUSIC.player && MUSIC.player.stopVideo) {
    try { MUSIC.player.stopVideo(); MUSIC.player.destroy(); } catch (e) {}
  }
  MUSIC.player = null;
  MUSIC.playingId = null;
  const holder = document.getElementById('ytMusicHolder');
  if (holder) holder.remove();
}

function musicLoadYouTubeApi() {
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve();
    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prevReady) prevReady(); resolve(); };
    if (document.getElementById('yt-iframe-api-tag')) return; // script đang tải, chờ callback ở trên
    const tag = document.createElement('script');
    tag.id = 'yt-iframe-api-tag';
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
}

async function musicFetchLinks() {
  try {
    const res = await fetch('/api/music-links');
    const data = await res.json();
    MUSIC.links = Array.isArray(data.links) ? data.links : [];
  } catch (e) {
    MUSIC.links = [];
  }
  MUSIC.loaded = true;
}

function musicSaveLinks() {
  fetch('/api/music-links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ links: MUSIC.links }),
  }).catch(() => { /* offline / không có server — danh sách vẫn dùng được trong phiên này */ });
}

function musicExtractYoutubeId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{6,})/);
  return m ? m[1] : null;
}

async function musicTogglePanel(force) {
  let panel = document.getElementById('musicPanel');
  const btn = document.getElementById('musicToggleBtn');
  const readerBody = document.getElementById('readerBody');
  const show = typeof force === 'boolean' ? force : !panel;
  if (!show) {
    if (panel) panel.remove();
    if (btn) btn.classList.remove('active');
    return;
  }
  if (panel || !readerBody) return;
  themeTogglePanel(false); // tránh 2 panel nổi đè nhau
  if (btn) btn.classList.add('active');
  panel = document.createElement('div');
  panel.id = 'musicPanel';
  panel.className = 'floating-panel music-panel';
  panel.innerHTML = `
    <div class="floating-panel-header">
      <span>🎵 Nhạc nền</span>
      <button class="floating-panel-close" onclick="musicTogglePanel(false)">✕</button>
    </div>
    <div class="music-add-row">
      <input type="text" id="musicUrlInput" placeholder="Dán link YouTube…">
      <input type="text" id="musicNameInput" placeholder="Tên nhạc (tuỳ chọn)">
      <button onclick="musicAddLink()">+ Thêm</button>
    </div>
    <div class="music-volume-row">
      <span>🔈</span>
      <input type="range" id="musicVolumeRange" min="0" max="100" value="${MUSIC.volume}" oninput="musicSetVolume(this.value)">
      <span id="musicVolumeVal">${MUSIC.volume}%</span>
    </div>
    <div class="music-list" id="musicList"><div class="epub-toc-empty">Đang tải…</div></div>`;
  readerBody.appendChild(panel);

  if (!MUSIC.loaded) await musicFetchLinks();
  musicRenderList();
}

function musicRenderList() {
  const list = document.getElementById('musicList');
  if (!list) return;
  if (!MUSIC.links.length) {
    list.innerHTML = '<div class="epub-toc-empty">Chưa có link nhạc nào — dán link YouTube ở trên để thêm.</div>';
    return;
  }
  list.innerHTML = MUSIC.links.map(l => `
    <div class="music-item${MUSIC.playingId === l.id ? ' playing' : ''}">
      <button class="music-play-btn" onclick="musicPlayTrack('${escAttr(l.id)}')" title="${MUSIC.playingId === l.id ? 'Tạm dừng' : 'Phát'}">
        ${MUSIC.playingId === l.id ? '⏸' : '▶'}
      </button>
      <span class="music-item-name" title="${escAttr(l.url)}">${esc(l.name || l.url)}</span>
      <button class="music-remove-btn" onclick="musicRemoveLink('${escAttr(l.id)}')" title="Xoá">✕</button>
    </div>`).join('');
}

function musicAddLink() {
  const urlInput = document.getElementById('musicUrlInput');
  const nameInput = document.getElementById('musicNameInput');
  const url = (urlInput.value || '').trim();
  if (!url) return;
  const vid = musicExtractYoutubeId(url);
  if (!vid) { alert('Link YouTube không hợp lệ. Hãy dán link dạng youtube.com/watch?v=... hoặc youtu.be/...'); return; }
  const name = (nameInput.value || '').trim() || 'Nhạc nền #' + (MUSIC.links.length + 1);
  const id = 'm' + Date.now();
  MUSIC.links.push({ id, name, url });
  urlInput.value = '';
  nameInput.value = '';
  musicRenderList();
  musicSaveLinks();
}

function musicRemoveLink(id) {
  MUSIC.links = MUSIC.links.filter(l => l.id !== id);
  if (MUSIC.playingId === id) musicStop();
  musicRenderList();
  musicSaveLinks();
}

function musicSetVolume(val) {
  MUSIC.volume = parseInt(val, 10);
  localStorage.setItem('music_volume', String(MUSIC.volume));
  const label = document.getElementById('musicVolumeVal');
  if (label) label.textContent = MUSIC.volume + '%';
  if (MUSIC.player && MUSIC.player.setVolume) {
    try { MUSIC.player.setVolume(MUSIC.volume); } catch (e) {}
  }
}

function musicStop() {
  if (MUSIC.player && MUSIC.player.stopVideo) {
    try { MUSIC.player.stopVideo(); } catch (e) {}
  }
  MUSIC.playingId = null;
  musicRenderList();
}

async function musicPlayTrack(id) {
  const track = MUSIC.links.find(l => l.id === id);
  if (!track) return;
  if (MUSIC.playingId === id) { musicStop(); return; }
  const vid = musicExtractYoutubeId(track.url);
  if (!vid) return;

  await musicLoadYouTubeApi();

  let holder = document.getElementById('ytMusicHolder');
  if (!holder) {
    holder = document.createElement('div');
    holder.id = 'ytMusicHolder';
    holder.style.cssText = 'position:fixed;width:2px;height:2px;overflow:hidden;opacity:0;pointer-events:none;bottom:0;right:0;';
    const inner = document.createElement('div');
    inner.id = 'ytMusicPlayer';
    holder.appendChild(inner);
    document.body.appendChild(holder);
  }

  if (MUSIC.player && MUSIC.player.loadVideoById) {
    MUSIC.player.loadVideoById(vid);
    MUSIC.player.setVolume(MUSIC.volume);
    MUSIC.playingId = id;
    musicRenderList();
    return;
  }

  MUSIC.player = new YT.Player('ytMusicPlayer', {
    videoId: vid,
    playerVars: { autoplay: 1, controls: 0, disablekb: 1 },
    events: {
      onReady: (e) => { e.target.setVolume(MUSIC.volume); e.target.playVideo(); },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED) { e.target.seekTo(0); e.target.playVideo(); } // lặp lại vô hạn
      },
    },
  });
  MUSIC.playingId = id;
  musicRenderList();
}

// ── READ ALOUD (TTS qua server localhost:3000, kiểu Piper/Nghi-TTS) ─────
// Server tương thích: cùng API /api/tts và /api/voices như dự án
// "epub-reader-offline" (tts_server.py) — POST text, nhận về base64 PCM16
// mono + sampleRate, phát bằng Web Audio API, tô sáng đoạn <p> đang đọc
// ngay trong iframe của epub.js để tiện theo dõi.
const RA_TTS_SERVER = 'http://localhost:3000';
const RA_HIGHLIGHT_STYLE_ID = 'ra-highlight-style-tag';
const RA_HIGHLIGHT_CSS = `
  .ra-active-p {
    background: linear-gradient(120deg, rgba(192,131,42,.38), rgba(192,131,42,.22)) !important;
    border-radius: 4px !important;
    box-shadow: 0 0 0 3px rgba(192,131,42,.22) !important;
    transition: background .25s ease, box-shadow .25s ease !important;
  }
  .ra-readable-p { cursor: pointer !important; }
  .ra-readable-p:hover { background: rgba(192,131,42,.10) !important; border-radius: 4px !important; }
`;

const RA = {
  open: false,          // panel đang mở?
  playing: false,       // đang phát audio?
  loading: false,       // đang chờ TTS trả dữ liệu?
  voices: {},            // danh sách giọng lấy từ /api/voices
  voicesLoaded: false,
  voice: localStorage.getItem('ra_voice') || '', // "piper:xxx" hoặc "nghitts:xxx"
  speed: parseFloat(localStorage.getItem('ra_speed') || '1'),
  paragraphs: [],        // đoạn văn của section đang hiển thị: {el, text, contents}
  currentIndex: -1,
  activeEl: null,        // <p> đang được tô sáng
  audioCtx: null,
  activeSource: null,
  currentBuffer: null,
  elapsedOffset: 0,
  startTimestamp: 0,
  cache: new Map(),      // idx -> {audio, sampleRate}
  pending: new Map(),    // idx -> Promise
  autoAdvance: false,    // vừa tự động next() sang chương mới để đọc tiếp
  errorMsg: null,
  seenDocs: new WeakSet(),
};

function raReset() {
  raStopAll();
  RA.open = false;
  RA.paragraphs = [];
  RA.currentIndex = -1;
  RA.activeEl = null;
  RA.cache.clear();
  RA.pending.clear();
  RA.autoAdvance = false;
  RA.errorMsg = null;
  RA.seenDocs = new WeakSet();
  const bar = document.getElementById('raBar');
  if (bar) bar.remove();
}

function raShutdown() {
  raStopAll();
  const bar = document.getElementById('raBar');
  if (bar) bar.remove();
  if (RA.audioCtx) { try { RA.audioCtx.close(); } catch (e) {} RA.audioCtx = null; }
  RA.open = false;
}

// ── Panel mở/đóng ──────────────────────────────────────────────
function raTogglePanel() {
  if (RA.open) { raClosePanel(); return; }
  raOpenPanel();
}

function raOpenPanel() {
  RA.open = true;
  document.getElementById('raToggleBtn')?.classList.add('active');
  const readerBody = document.getElementById('readerBody');
  if (!readerBody || document.getElementById('raBar')) return;

  const bar = document.createElement('div');
  bar.id = 'raBar';
  bar.className = 'ra-bar';
  bar.innerHTML = `
    <div class="ra-progress-track"><div class="ra-progress-fill" id="raProgressFill" style="width:0%"></div></div>
    <button class="ra-playbtn" id="raPlayBtn" onclick="raTogglePlayPause()" title="Phát/Tạm dừng">▶</button>
    <button class="ra-stopbtn" onclick="raStopAll()" title="Dừng">■</button>
    <div class="ra-info">
      <div class="ra-status-main" id="raStatusMain">Chưa đọc</div>
      <div class="ra-status-sub" id="raStatusSub">Bấm ▶ hoặc nhấn vào 1 đoạn văn để bắt đầu</div>
    </div>
    <select class="ra-voice-select" id="raVoiceSelect" onchange="raOnVoiceChange(this.value)"><option>Đang tải giọng đọc…</option></select>
    <div class="ra-speed-wrap">
      <span>Tốc độ</span>
      <input type="range" class="ra-speed-range" id="raSpeedRange" min="0.5" max="2" step="0.05" value="${RA.speed}" oninput="raOnSpeedChange(this.value)">
      <span class="ra-speed-val" id="raSpeedVal">${RA.speed.toFixed(2)}x</span>
    </div>
    <button class="ra-closebtn" onclick="raClosePanel()" title="Đóng">✕</button>
  `;
  readerBody.appendChild(bar);
  raLoadVoices();
  raCollectParagraphs(); // gom đoạn văn của trang đang hiển thị (nếu đã render sẵn)
}

function raClosePanel() {
  raStopAll();
  RA.open = false;
  document.getElementById('raToggleBtn')?.classList.remove('active');
  const bar = document.getElementById('raBar');
  if (bar) bar.remove();
}

// ── Tải danh sách giọng đọc từ server ─────────────────────────
function raLoadVoices() {
  fetch(RA_TTS_SERVER + '/api/voices')
    .then(r => r.json())
    .then(data => {
      RA.voices = data || {};
      RA.voicesLoaded = true;
      raBuildVoiceOptions();
    })
    .catch(() => {
      RA.voicesLoaded = true;
      raShowError('Không kết nối được TTS server tại ' + RA_TTS_SERVER + '. Hãy chạy start.bat (hoặc python tts_server.py) trước rồi thử lại.');
      const sel = document.getElementById('raVoiceSelect');
      if (sel) sel.innerHTML = '<option>⚠ Server chưa chạy</option>';
    });
}

function raBuildVoiceOptions() {
  const sel = document.getElementById('raVoiceSelect');
  if (!sel) return;
  const entries = Object.entries(RA.voices);
  if (entries.length === 0) { sel.innerHTML = '<option>Không có giọng nào</option>'; return; }

  const piper = entries.filter(([k]) => k.startsWith('piper:'));
  const nghitts = entries.filter(([k]) => k.startsWith('nghitts:'));
  const other = entries.filter(([k]) => !k.startsWith('piper:') && !k.startsWith('nghitts:'));

  const optHtml = ([key, info]) =>
    `<option value="${escAttr(key)}"${!info.downloaded ? ' disabled' : ''}>${esc(info.label || key)}${!info.downloaded ? ' ⚠ chưa tải' : ''}</option>`;

  let html = '';
  if (piper.length) html += `<optgroup label="Piper TTS">${piper.map(optHtml).join('')}</optgroup>`;
  if (nghitts.length) html += `<optgroup label="Nghi-TTS">${nghitts.map(optHtml).join('')}</optgroup>`;
  if (other.length) html += other.map(optHtml).join('');
  sel.innerHTML = html;

  // Chọn giọng: ưu tiên giọng đã lưu trước đó nếu còn tồn tại & đã tải,
  // nếu không thì chọn giọng đầu tiên đã tải sẵn.
  let chosen = RA.voice && RA.voices[RA.voice] && RA.voices[RA.voice].downloaded ? RA.voice : '';
  if (!chosen) {
    const firstDownloaded = entries.find(([, v]) => v.downloaded);
    chosen = firstDownloaded ? firstDownloaded[0] : (entries[0] ? entries[0][0] : '');
  }
  RA.voice = chosen;
  sel.value = chosen;
  if (chosen) localStorage.setItem('ra_voice', chosen);
}

function raOnVoiceChange(val) {
  RA.voice = val;
  localStorage.setItem('ra_voice', val);
  RA.cache.clear();
  RA.pending.clear();
  RA.currentBuffer = null;
}

function raOnSpeedChange(val) {
  RA.speed = parseFloat(val);
  localStorage.setItem('ra_speed', String(RA.speed));
  const label = document.getElementById('raSpeedVal');
  if (label) label.textContent = RA.speed.toFixed(2) + 'x';
  if (RA.activeSource) { try { RA.activeSource.playbackRate.value = RA.speed; } catch (e) {} }
  RA.cache.clear();
  RA.pending.clear();
}

function raShowError(msg) {
  RA.errorMsg = msg;
  const sub = document.getElementById('raStatusSub');
  let err = document.getElementById('raErrorMsg');
  if (!err) {
    err = document.createElement('div');
    err.id = 'raErrorMsg';
    err.className = 'ra-error-msg';
    document.getElementById('raBar')?.appendChild(err);
  }
  err.textContent = '⚠ ' + msg;
}

function raClearError() {
  RA.errorMsg = null;
  document.getElementById('raErrorMsg')?.remove();
}

// ── Dò đoạn văn (<p>) trong iframe epub.js hiện tại ──────────────
// Được gọi mỗi khi epub.js render nội dung 1 section vào iframe mới.
function raOnContentLoaded(contents) {
  try {
    const doc = contents.document;
    if (!doc || RA.seenDocs.has(doc)) return; // tránh gắn trùng nếu hook fire lại trên cùng document
    RA.seenDocs.add(doc);

    // Chèn CSS tô sáng vào bên trong iframe (CSS ngoài không lọt vào được vì
    // iframe là 1 document độc lập).
    if (!doc.getElementById(RA_HIGHLIGHT_STYLE_ID)) {
      const styleTag = doc.createElement('style');
      styleTag.id = RA_HIGHLIGHT_STYLE_ID;
      styleTag.textContent = RA_HIGHLIGHT_CSS;
      doc.head?.appendChild(styleTag);
    }

    raCollectParagraphs();
  } catch (e) {
    // im lặng bỏ qua — 1 số section (trang bìa, trang trắng...) có thể không có <p>
  }
}

// Gom toàn bộ <p> (rơi vào trường hợp không có <p> thì lấy li/div có chữ)
// từ tất cả iframe đang render (chế độ 1 trang hoặc spread 2 trang), gắn
// sự kiện click "đọc từ đây" và style con trỏ tay.
function raCollectParagraphs() {
  if (!currentEpubRendition) return;
  let contentsList = [];
  try { contentsList = currentEpubRendition.getContents() || []; } catch (e) { return; }
  if (!contentsList.length) return;

  const wasPlayingIdx = RA.currentIndex;
  const list = [];

  contentsList.forEach(contents => {
    const doc = contents.document;
    if (!doc || !doc.body) return;
    let nodes = Array.from(doc.body.querySelectorAll('p'));
    if (nodes.length === 0) {
      nodes = Array.from(doc.body.querySelectorAll('li, blockquote, h1, h2, h3, h4, div'))
        .filter(el => el.children.length === 0); // chỉ lấy node lá để tránh trùng lặp text
    }
    nodes.forEach(el => {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 2) return;
      if (!el.classList.contains('ra-readable-p')) {
        el.classList.add('ra-readable-p');
        el.addEventListener('click', () => raHandleParagraphClick(el));
      }
      list.push({ el, text, contents });
    });
  });

  RA.paragraphs = list;

  if (RA.autoAdvance && RA.playing) {
    // Vừa tự động next() sang section mới trong lúc đang phát -> đọc tiếp từ đầu
    RA.autoAdvance = false;
    if (list.length > 0) {
      setTimeout(() => raPlayFromIndex(0), 250);
    } else {
      // Section này không có đoạn nào đọc được -> thử qua section kế tiếp
      setTimeout(() => raAdvanceSection(), 150);
    }
  } else if (wasPlayingIdx >= 0) {
    RA.currentIndex = -1; // section đổi ngoài ý muốn (VD người dùng bấm nav) -> reset chỉ số
  }
}

function raHandleParagraphClick(el) {
  const idx = RA.paragraphs.findIndex(p => p.el === el);
  if (idx < 0) return;
  if (!RA.open) raOpenPanel();
  RA.currentBuffer = null;
  RA.elapsedOffset = 0;
  raPlayFromIndex(idx);
}

// ── Playback engine (Web Audio API, PCM16 mono base64 giống tts_server.py) ──
function raParagraphKey(idx) { return String(idx); }

function raStopSource() {
  if (RA.activeSource) {
    try { RA.activeSource.onended = null; RA.activeSource.stop(); } catch (e) {}
    RA.activeSource = null;
  }
}

function raStopAll() {
  raStopSource();
  RA.playing = false;
  RA.loading = false;
  raClearHighlight();
  RA.currentIndex = -1;
  RA.elapsedOffset = 0;
  RA.currentBuffer = null;
  RA.cache.clear();
  RA.pending.clear();
  raUpdateStatusUI();
  raUpdatePlayBtn();
}

function raClearHighlight() {
  if (RA.activeEl) { RA.activeEl.classList.remove('ra-active-p'); RA.activeEl = null; }
}

async function raFetchTTS(text) {
  const [engine, voiceKey] = RA.voice.includes(':') ? RA.voice.split(':') : ['piper', RA.voice];
  const res = await fetch(RA_TTS_SERVER + '/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, engine, voice: voiceKey, speed: RA.speed }),
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || `Lỗi TTS server (HTTP ${res.status})`);
  }
  const data = await res.json();
  if (!data.audio) throw new Error('Server không trả về dữ liệu âm thanh.');
  return { audio: data.audio, sampleRate: data.sampleRate || 22050 };
}

function raPrefetch(idx) {
  const item = RA.paragraphs[idx];
  if (!item) return;
  const key = raParagraphKey(idx);
  if (RA.cache.has(key) || RA.pending.has(key)) return;
  const promise = raFetchTTS(item.text)
    .then(result => { RA.cache.set(key, result); RA.pending.delete(key); return result; })
    .catch(() => { RA.pending.delete(key); return undefined; });
  RA.pending.set(key, promise);
}

async function raDecodeBuffer(base64Str, sampleRate) {
  const binary = atob(base64Str);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  const numSamples = Math.floor(len / 2);
  const view = new DataView(bytes.buffer);
  const floatData = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) floatData[i] = view.getInt16(i * 2, true) / 32768;

  if (!RA.audioCtx || RA.audioCtx.sampleRate !== sampleRate) {
    if (RA.audioCtx) { try { await RA.audioCtx.close(); } catch (e) {} }
    RA.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
  }
  const ctx = RA.audioCtx;
  if (ctx.state === 'suspended') await ctx.resume();
  const buffer = ctx.createBuffer(1, numSamples, sampleRate);
  buffer.getChannelData(0).set(floatData);
  return buffer;
}

function raPlayBuffer(buffer, startOffset, idx) {
  const ctx = RA.audioCtx;
  if (!ctx) return;
  raStopSource();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = RA.speed;
  source.connect(ctx.destination);
  source.onended = () => {
    if (RA.playing && RA.activeSource === source) raHandleParagraphEnded(idx);
  };
  RA.activeSource = source;
  RA.startTimestamp = ctx.currentTime - startOffset / RA.speed;
  RA.elapsedOffset = startOffset;
  source.start(0, startOffset);
  RA.loading = false;
  RA.playing = true;
  raUpdateStatusUI();
  raUpdatePlayBtn();
}

async function raPlayFromIndex(idx, startOffset = 0) {
  if (idx >= RA.paragraphs.length) { raAdvanceSection(); return; }
  const item = RA.paragraphs[idx];
  if (!item) return;

  if (!RA.voice) {
    raShowError('Chưa chọn được giọng đọc (hoặc server TTS chưa chạy).');
    return;
  }
  raClearError();
  raStopSource();
  raClearHighlight();
  RA.currentIndex = idx;
  RA.activeEl = item.el;
  item.el.classList.add('ra-active-p');

  // Cuộn tới đúng vị trí đoạn văn — dùng CFI để epub.js tự lật đúng trang
  // (vì nội dung được phân trang bằng CSS column, không phải scroll thường).
  try {
    const cfi = item.contents.cfiFromNode(item.el);
    if (cfi) currentEpubRendition.display(cfi);
    else item.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    try { item.el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e2) {}
  }

  // Resume đúng vị trí đang phát dở (bấm tạm dừng rồi bấm play lại)
  if (RA.currentBuffer && RA.currentIndex === idx && startOffset > 0) {
    raPlayBuffer(RA.currentBuffer, startOffset, idx);
    return;
  }

  RA.loading = true;
  RA.playing = true;
  raUpdateStatusUI();
  raUpdatePlayBtn();

  const key = raParagraphKey(idx);
  try {
    let result = RA.cache.get(key);
    if (result) {
      RA.cache.delete(key);
    } else {
      const pending = RA.pending.get(key);
      result = pending ? await pending : await raFetchTTS(item.text);
      RA.pending.delete(key);
    }
    if (!result) result = await raFetchTTS(item.text); // prefetch lỗi -> thử lại 1 lần

    // Nếu người dùng đã bấm dừng/đổi đoạn trong lúc chờ tải thì bỏ qua kết quả trễ này
    if (RA.currentIndex !== idx || !RA.playing) return;

    // Tải trước đoạn kế tiếp ngay khi có dữ liệu đoạn hiện tại để phát liền mạch
    if (idx + 1 < RA.paragraphs.length) raPrefetch(idx + 1);

    RA.currentBuffer = await raDecodeBuffer(result.audio, result.sampleRate);
    if (RA.currentIndex !== idx || !RA.playing) return;
    raPlayBuffer(RA.currentBuffer, startOffset, idx);
  } catch (err) {
    raShowError(err.message || 'Không thể tạo âm thanh cho đoạn này.');
    RA.playing = false;
    RA.loading = false;
    raUpdateStatusUI();
    raUpdatePlayBtn();
  }
}

function raHandleParagraphEnded(idx) {
  RA.currentBuffer = null;
  RA.elapsedOffset = 0;
  if (idx + 1 < RA.paragraphs.length) {
    raPlayFromIndex(idx + 1);
  } else {
    raAdvanceSection();
  }
}

// Hết đoạn văn của section/chương hiện tại -> tự lật sang chương kế tiếp và
// đọc tiếp từ đầu (giống hành vi audiobook liên tục của epub-reader-offline).
function raAdvanceSection() {
  if (!currentEpubRendition) { raStopAll(); return; }
  const beforeCount = RA.paragraphs.length;
  RA.autoAdvance = true;
  RA.loading = true;
  raUpdateStatusUI();
  currentEpubRendition.next().then(() => {
    // Nếu đã ở chương cuối, epub.js sẽ không có gì thay đổi -> dừng lại sau 1 khoảng chờ
    setTimeout(() => {
      if (RA.autoAdvance && RA.paragraphs.length === beforeCount) {
        RA.autoAdvance = false;
        RA.playing = false;
        RA.loading = false;
        raClearHighlight();
        RA.currentIndex = -1;
        document.getElementById('raStatusMain').textContent = 'Đã đọc hết sách';
        document.getElementById('raStatusSub').textContent = '📖 Hoàn thành';
        raUpdatePlayBtn();
      }
    }, 900);
  }).catch(() => {
    RA.autoAdvance = false;
    raStopAll();
  });
}

function raTogglePlayPause() {
  if (!RA.voice) { raShowError('Chưa có giọng đọc khả dụng — kiểm tra TTS server.'); return; }
  if (RA.currentIndex < 0) {
    // Chưa đọc đoạn nào -> bắt đầu từ đoạn đầu tiên đang hiển thị
    raCollectParagraphs();
    raPlayFromIndex(0);
    return;
  }
  if (RA.playing && RA.activeSource) {
    // Tạm dừng: lưu lại vị trí đang phát dở để resume đúng chỗ
    if (RA.audioCtx) {
      const elapsed = (RA.audioCtx.currentTime - RA.startTimestamp) * RA.speed;
      RA.elapsedOffset = Math.min(elapsed, RA.currentBuffer?.duration ?? 0);
    }
    raStopSource();
    RA.playing = false;
    raUpdateStatusUI();
    raUpdatePlayBtn();
  } else {
    RA.playing = true;
    raPlayFromIndex(RA.currentIndex, RA.elapsedOffset);
  }
}

function raUpdatePlayBtn() {
  const btn = document.getElementById('raPlayBtn');
  if (!btn) return;
  if (RA.loading) { btn.innerHTML = '<span style="display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite"></span>'; }
  else if (RA.playing) { btn.textContent = '❚❚'; }
  else { btn.textContent = '▶'; }
}

function raUpdateStatusUI() {
  const main = document.getElementById('raStatusMain');
  const sub = document.getElementById('raStatusSub');
  const fill = document.getElementById('raProgressFill');
  if (!main || !sub) return;
  if (RA.currentIndex < 0) {
    main.textContent = 'Chưa đọc';
    sub.textContent = 'Bấm ▶ hoặc nhấn vào 1 đoạn văn để bắt đầu';
    if (fill) fill.style.width = '0%';
    return;
  }
  const total = RA.paragraphs.length;
  main.textContent = RA.loading ? 'Đang tải giọng đọc…' : (RA.playing ? 'Đang đọc…' : 'Tạm dừng');
  sub.textContent = `Đoạn ${RA.currentIndex + 1}/${total}`;
  if (fill) fill.style.width = total ? `${Math.round(((RA.currentIndex + 1) / total) * 100)}%` : '0%';
}

// Thêm keyframe spin cho icon loading trên nút play (chỉ cần chèn 1 lần)
(function raInjectSpinKeyframe() {
  const s = document.createElement('style');
  s.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(s);
})();

// ── PDF READER (pdf.js) ────────────────────────────────────────
if (window['pdfjsLib']) {
  // Build the worker as an in-memory Blob URL (no network needed, works on file://)
  const __workerBytes = __b64ToUint8Array(__PDF_WORKER_B64__);
  const __workerBlob = new Blob([__workerBytes], { type: 'application/javascript' });
  pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(__workerBlob);
}

async function openPdfReader(arrayBuffer, title, fileObj) {
  openReader(title, fileObj, sanitizeFilename(title) + '.pdf');
  const body = document.getElementById('readerBody');
  body.innerHTML = `<div id="pdfViewer"><div class="reader-loading" id="pdfLoading">📄 <span>Đang tải PDF...</span></div></div>`;
  document.getElementById('readerTools').innerHTML = `
    <button onclick="pdfZoom(-0.15)" title="Thu nhỏ">−</button>
    <span id="pdfZoomLabel">${Math.round(currentPdfZoom*100)}%</span>
    <button onclick="pdfZoom(0.15)" title="Phóng to">+</button>`;

  try {
    // Pass raw bytes directly so pdf.js doesn't try to fetch a URL.
    currentPdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    await renderAllPdfPages();
  } catch (err) {
    document.getElementById('pdfViewer').innerHTML =
      `<div class="reader-loading">⚠️ Không đọc được file PDF: ${esc(err.message || '')}</div>`;
  }
}

async function renderAllPdfPages() {
  const viewer = document.getElementById('pdfViewer');
  if (!viewer || !currentPdfDoc) return;
  viewer.innerHTML = '';
  const numPages = currentPdfDoc.numPages;
  for (let i = 1; i <= numPages; i++) {
    const page = await currentPdfDoc.getPage(i);
    const viewport = page.getViewport({ scale: currentPdfZoom });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    viewer.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  }
}

let pdfZoomTimer = null;
function pdfZoom(delta) {
  currentPdfZoom = Math.min(3, Math.max(0.4, +(currentPdfZoom + delta).toFixed(2)));
  document.getElementById('pdfZoomLabel').textContent = Math.round(currentPdfZoom * 100) + '%';
  clearTimeout(pdfZoomTimer);
  pdfZoomTimer = setTimeout(renderAllPdfPages, 250);
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModalDirect(); });

// ── VIEW ──────────────────────────────────────────────────────
function setView(mode) {
  document.getElementById('btnGrid').classList.toggle('active', mode === 'grid');
  document.getElementById('btnList').classList.toggle('active', mode === 'list');
  document.body.classList.toggle('list-view', mode === 'list');
}

// ── UTILS ─────────────────────────────────────────────────────
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) { return (s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }
function fmtIcon(f) {
  const icons = {EPUB:'📘',PDF:'📄',MP3:'🎵',M4B:'🎙',AAC:'🎧',MOBI:'📱',AZW3:'📱',OGG:'🎵',FLAC:'🎵'};
  return icons[f] || '📂';
}
function langFlag(code) {
  const flags = {vie:'🇻🇳',eng:'🇺🇸',zho:'🇨🇳',jpn:'🇯🇵',kor:'🇰🇷',fra:'🇫🇷',deu:'🇩🇪',ita:'🇮🇹',spa:'🇪🇸'};
  return flags[code] || '🌐';
}
function langName(code) {
  const names = {vie:'Tiếng Việt',eng:'Tiếng Anh',zho:'Tiếng Trung',jpn:'Tiếng Nhật',kor:'Tiếng Hàn',fra:'Tiếng Pháp',deu:'Tiếng Đức',ita:'Tiếng Ý',spa:'Tiếng Tây Ban Nha'};
  return names[code] || code;
}
function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function showEmpty(msg) {
  document.getElementById('loadingMain').innerHTML =
    `<div class="empty"><div class="empty-icon">📭</div><div>${msg}</div></div>`;
}
