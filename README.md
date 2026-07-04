# 📚 Sách Nói EPUB — Piper TTS + Nghi-TTS (CPU-only, Offline)

Ứng dụng đọc sách EPUB thành tiếng, chạy **hoàn toàn offline** trên máy tính của bạn, không cần API key, không cần GPU.

## 🖥️ Chạy như ứng dụng Desktop (.exe) — không cần mở trình duyệt

Ứng dụng giờ có thể đóng gói thành **1 file `.exe` chạy như app desktop bình thường**: click đúp là mở ra một cửa sổ riêng (dùng WebView2 có sẵn trên Windows 10/11), không có thanh địa chỉ, không mở trình duyệt/tab, không cần mở terminal.

### Cách 1 — Tự đóng gói file .exe (khuyên dùng)

1. Cài **Python 3.9–3.12**: https://www.python.org/downloads/ (tick "Add Python to PATH")
2. Cài **Node.js**: https://nodejs.org/ (chỉ cần lúc đóng gói, không cần sau khi có file .exe)
3. Nhấp đúp **`build_exe.bat`** và đợi (lần đầu mất vài phút vì phải cài thư viện + tải giọng đọc + build).
4. Xong! File chạy được nằm tại: **`dist_exe\SachNoiEPUB.exe`**
5. Copy file này ra Desktop (hoặc bất kỳ đâu) — click đúp để mở app, không cần Python/Node/terminal nữa.

Lần chạy đầu tiên, app sẽ tạo thư mục `voices` **ngay cạnh file .exe** để lưu giọng đọc đã tải (giữ nguyên giữa các lần mở). Nếu muốn mang file .exe sang máy khác mà không cần tải lại giọng, hãy copy cả file `.exe` lẫn thư mục `voices` đi cùng.

### Cách 2 — Chạy thử chế độ desktop mà chưa cần đóng gói .exe

Nhấp đúp **`Chay_Thu_Desktop.bat`** — mở cửa sổ desktop ngay bằng Python (không tạo ra file .exe), tiện để kiểm tra trước khi build.

### Nếu `build_exe.bat` báo lỗi "No module named ..."

Một số thư viện (piper, onnxruntime, phonemizer...) đóng gói kèm file dữ liệu nhị phân mà PyInstaller đôi khi bỏ sót. Mở `build_exe.bat`, thêm dòng `--collect-all ten_module_bi_thieu` vào đoạn lệnh `PyInstaller` rồi chạy lại.

---

## Chạy kiểu cũ (server + mở trình duyệt)

Các cách chạy dưới đây vẫn hoạt động bình thường như trước (dùng khi phát triển/debug, hoặc nếu chưa muốn đóng gói .exe).

## Đặc điểm

- 🎙️ **Piper TTS** — tổng hợp giọng nói tiếng Việt chạy trên CPU, không cần internet sau khi tải model lần đầu.
- 🗣️ **Nghi-TTS** ([nghimestudio/nghitts](https://github.com/nghimestudio/nghitts)) — bộ giọng đọc tiếng Việt fine-tune từ Piper, cùng định dạng `.onnx` nên chạy chung engine với Piper ở trên, không cần thêm phần mềm nào khác.
- 📖 **EPUB Parser tự viết** — đọc đúng cấu trúc `OEBPS/contents/page*.xhtml`, hỗ trợ cả EPUB2 (NCX) và EPUB3 (nav).
- 🖥️ **Server local** — Flask (Python) phục vụ cả giao diện web lẫn API TTS tại `http://localhost:3000`.
- 🎨 4 giao diện đọc (Sáng / Giấy / Xám / Tối), tùy chỉnh font chữ, cỡ chữ, tốc độ đọc.

## Cài đặt nhanh (Windows)

1. Cài **Python 3.9+**: https://www.python.org/downloads/ (nhớ tick "Add Python to PATH")
2. Cài **Node.js**: https://nodejs.org/ (chỉ cần cho lần build đầu tiên)
3. Nhấp đúp vào **`start.bat`**

File `start.bat` sẽ tự động:
- Cài thư viện Python (Flask, piper-tts)
- Tải model giọng đọc tiếng Việt (`vi_VN-vais1000-medium`, ~50MB)
- Kiểm tra model Nghi-TTS trong `voices/nghitts/` (không tự tải, xem hướng dẫn bên dưới)
- Build giao diện React (lần đầu)
- Mở trình duyệt tại `http://localhost:3000`

Lần chạy sau, chỉ cần nhấp `start.bat` lại — không cần build lại.

## Cài đặt thủ công (macOS / Linux)

```bash
# 1. Cài thư viện Python
pip install -r requirements.txt

# 2. Tải model giọng đọc Piper
python tts_server.py --download vais1000-medium

# 2b. (Tuỳ chọn) Tải model Nghi-TTS
python tts_server.py --download-nghitts

# 3. Build giao diện
npm install
npm run build

# 4. Khởi động server
python tts_server.py --port 3000
```

Sau đó mở trình duyệt: http://localhost:3000

## Phát triển (dev mode với hot-reload)

```bash
# Terminal 1: chạy backend TTS
python tts_server.py --port 3000

# Terminal 2: chạy frontend dev server (proxy /api sang port 3000)
npm run dev
```

Mở: http://localhost:5173

## Các giọng đọc có sẵn

| Mã giọng           | Mô tả                          |
|--------------------|---------------------------------|
| `vais1000-medium`  | Giọng nữ, chất lượng cao (khuyên dùng) |
| `vivos-x_low`      | Đa giọng, nhẹ, tốc độ nhanh     |
| `25hours-low`      | Giọng nữ, nhẹ                   |

Tải thêm giọng:
```bash
python tts_server.py --download <ten-giong>
```

Liệt kê trạng thái giọng:
```bash
python tts_server.py --list
```

## Giọng đọc Nghi-TTS (nghimestudio/nghitts)

[nghitts](https://github.com/nghimestudio/nghitts) là bộ checkpoint Piper được cộng đồng fine-tune bằng nhiều giọng đọc tiếng Việt (Calm Woman, Deep Man, Ngọc Ngân, Việt Thảo, Mỹ Tâm, Trấn Thành...). Vì cùng định dạng `.onnx` + `.onnx.json` với Piper, ứng dụng **tái sử dụng engine Piper** để chạy các model này — không cần cài thêm thư viện nào ngoài `gdown` (đã có sẵn trong `requirements.txt`).

**Cách 1 — Tự động (khuyên dùng):**
```bash
python tts_server.py --download-nghitts
```
Lệnh này tải toàn bộ thư mục model công khai trên Google Drive của tác giả nghitts vào `voices/nghitts/`.

**Cách 2 — Thủ công:**
1. Tải file `<tên-giọng>.onnx` và `<tên-giọng>.onnx.json` từ [Google Drive của nghitts](https://drive.google.com/drive/folders/1f_pCpvgqfvO4fdNKM7WS4zTuXC0HBskL) hoặc từ trang [nghitts.app](https://nghitts.app).
2. Copy cả 2 file vào thư mục `voices/nghitts/` trong dự án.
3. Khởi động lại server — model mới sẽ **tự động xuất hiện** trong danh sách giọng đọc (nhóm "Nghi-TTS") mà không cần sửa code, kể cả các model nghitts phát hành sau này.

Kiểm tra các giọng Nghi-TTS đã có:
```bash
python tts_server.py --list
```

## Cấu trúc EPUB được hỗ trợ

Parser hỗ trợ cấu trúc EPUB chuẩn lẫn cấu trúc đặc biệt như:
```
META-INF/container.xml
OEBPS/content.opf
OEBPS/contents/toc.xhtml
OEBPS/contents/page0001.xhtml
OEBPS/contents/page0002.xhtml
...
```
Parser tự đọc `container.xml` → `content.opf` (manifest + spine) → trích chương theo đúng thứ tự đọc (spine order), lấy tên chương từ TOC (nav/NCX), và trích đoạn văn từ thẻ `<p>`.

## Chuyển EPUB thành Audiobook (mp3)

Ngoài trang đọc chính, ứng dụng có thêm trang **`/epub2audiobook`** (cả khi chạy qua `start.bat` lẫn khi chạy file `.exe` desktop, cùng trong 1 cửa sổ — chỉ cần bấm nút **"Tạo Audiobook"** ở góc trên bên phải):

1. Tải file `.epub` lên (dùng chung bộ nhận diện chương với trang đọc).
2. Chọn giọng đọc + tốc độ, tick chọn những chương muốn tạo audio (mặc định chọn hết).
3. Bấm **"Bắt đầu tạo audiobook"** — ứng dụng gọi TTS cho từng đoạn văn trong từng chương, ghép lại (kèm khoảng lặng giữa các đoạn) và **mã hoá MP3 ngay trên trình duyệt/cửa sổ desktop** (không cần ffmpeg/cài thêm gì) → mỗi chương ra **1 file `.mp3` riêng**.
4. Nghe thử / tải từng file, hoặc bấm **"Tải tất cả (ZIP)"** để tải nguyên bộ audiobook cùng lúc.
5. Chương nào lỗi (mất mạng nội bộ, model treo...) có thể bấm **"Thử lại"** riêng chương đó mà không cần tạo lại từ đầu.

Việc mã hoá MP3 dùng thư viện `@breezystack/lamejs` (pure JavaScript, chạy trong WebView2/trình duyệt), nên chỉ cần build lại (`npm run build` hoặc chạy lại `build_exe.bat`) là có ngay tính năng này, không cần cài thêm phần mềm ngoài.

## Công nghệ

- **Frontend:** React 19, Vite, TailwindCSS, JSZip (parse EPUB ngay trên trình duyệt)
- **Backend:** Python Flask + piper-tts (ONNX Runtime, CPU-only) — dùng chung cho cả Piper và Nghi-TTS
- **Không cần:** API key, GPU, kết nối internet (sau khi tải model lần đầu)
