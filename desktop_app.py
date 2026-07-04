"""
desktop_app.py
────────────────────────────────────────────────────────────────────────────
Điểm khởi động của ứng dụng DESKTOP (file .exe).

Khác với start.bat / tts_server.py chạy trực tiếp (mở trình duyệt), file này:
  1. Chạy server Flask (tts_server.py) ở một thread nền, cổng được chọn tự
     động (thử 3000 trước, nếu bận thì dò cổng trống khác).
  2. Mở một CỬA SỔ DESKTOP THẬT (dùng pywebview — bọc WebView2/Edge có sẵn
     trên Windows 10/11) trỏ tới server đó. Không mở trình duyệt, không có
     thanh địa chỉ, không có tab — trông và chạy như một ứng dụng .exe bình
     thường.
  3. Khi người dùng đóng cửa sổ, tiến trình thoát hoàn toàn (server nền cũng
     tự dừng theo vì chạy ở daemon thread).

File này được PyInstaller đóng gói làm entry-point khi build .exe
(xem build_exe.bat).
"""

import base64
import logging
import socket
import sys
import threading
import time
import urllib.request

# Giảm bớt log rác của werkzeug (Flask dev server) khi chạy dưới dạng app nền
logging.getLogger("werkzeug").setLevel(logging.WARNING)


def _port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _pick_port(preferred: int = 3000) -> int:
    for port in (preferred, 3001, 3002, 5000, 5050, 8765):
        if _port_is_free(port):
            return port
    # Không cổng ưu tiên nào rảnh -> để hệ điều hành tự cấp 1 cổng ngẫu nhiên
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_until_ready(url: str, timeout_s: float = 60.0) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.0) as resp:
                if resp.status < 500:
                    return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


def main() -> None:
    # Import ở đây (không phải đầu file) để mọi cấu hình đường dẫn / espeak
    # bên trong tts_server.py (BASE_DIR, BUNDLE_DIR, _setup_espeak...) chạy
    # đúng thứ tự trước khi ta dùng tới app Flask.
    import tts_server as backend

    port = _pick_port(3000)
    base_url = f"http://127.0.0.1:{port}"

    # Chuẩn bị giọng đọc Piper mặc định nếu máy chưa có (giống hành vi khi
    # chạy "python tts_server.py" trực tiếp). Lần đầu cần internet để tải
    # (~50MB); các lần sau sẽ có sẵn trong thư mục "voices" cạnh file .exe.
    try:
        if not any(backend.get_piper_model_path(k) for k in backend.AVAILABLE_VOICES):
            print("Đang tải giọng đọc mặc định lần đầu, vui lòng đợi (~50MB)...")
            backend.download_piper_voice(backend.DEFAULT_VOICE)
        if backend.get_piper_model_path(backend.DEFAULT_VOICE):
            backend.load_piper_voice(backend.DEFAULT_VOICE)
    except Exception as e:
        print(f"[Cảnh báo] Không chuẩn bị được giọng Piper mặc định: {e}")

    def run_server():
        backend.app.run(
            host="127.0.0.1",
            port=port,
            debug=False,
            threaded=True,
            use_reloader=False,
        )

    server_thread = threading.Thread(target=run_server, daemon=True)
    server_thread.start()

    if not _wait_until_ready(base_url):
        print(f"[Lỗi] Server không khởi động được tại {base_url}")
        sys.exit(1)

    try:
        import webview
    except ImportError:
        # Môi trường chưa cài pywebview (vd. chạy thử bằng "python
        # desktop_app.py" mà quên cài) -> báo rõ thay vì crash im lặng.
        print("Chưa cài pywebview. Chạy: pip install pywebview")
        print(f"Bạn có thể mở tạm bằng trình duyệt tại: {base_url}")
        server_thread.join()
        return

    class Api:
        """Cầu nối JS <-> Python để LƯU FILE trong bản .exe.

        Cửa sổ desktop dùng WebView2 (Edge) lồng bên trong, và trình duyệt
        lồng này KHÔNG hỗ trợ tải file từ blob: URL qua thẻ <a download>
        như Chrome/Edge thật ngoài trình duyệt — bấm nút "Tải" sẽ không có
        phản ứng gì. Vì vậy phía JS (EpubToAudiobook.tsx) sẽ gọi hàm
        save_blob() này qua window.pywebview.api, gửi kèm nội dung file mã
        hoá base64; ở đây ta mở hộp thoại "Lưu file" gốc của Windows rồi
        ghi dữ liệu ra đĩa thật.
        """

        def __init__(self):
            self.window = None  # gán ngay sau khi tạo cửa sổ, xem bên dưới

        def save_blob(self, filename: str, base64_data: str):
            try:
                result = self.window.create_file_dialog(
                    webview.SAVE_DIALOG, save_filename=filename or "file"
                )
                if not result:
                    return {"ok": False, "cancelled": True}
                path = result[0] if isinstance(result, (list, tuple)) else result
                data = base64.b64decode(base64_data)
                with open(path, "wb") as f:
                    f.write(data)
                return {"ok": True, "path": path}
            except Exception as e:  # noqa: BLE001 - báo lỗi rõ ràng về JS
                return {"ok": False, "error": str(e)}

    api = Api()
    window = webview.create_window(
        "Sách Nói EPUB — Piper TTS + Nghi-TTS",
        base_url,
        width=1320,
        height=880,
        min_size=(960, 640),
        text_select=True,
        js_api=api,
    )
    api.window = window
    # confirm_close=False: đóng cửa sổ là thoát luôn, không hỏi lại.
    webview.start(private_mode=False)
    sys.exit(0)


if __name__ == "__main__":
    main()
