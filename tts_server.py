"""
TTS Server - hỗ trợ 2 engine:
  1. Piper TTS      (CPU-only, nhẹ, nhanh) — giọng gốc rhasspy/piper-voices
  2. Nghi-TTS       (github.com/nghimestudio/nghitts) — checkpoint Piper được
                     fine-tune bằng giọng người Việt/celebrity. Cùng định dạng
                     .onnx/.onnx.json với Piper nên dùng chung engine suy luận,
                     chỉ khác thư mục chứa model và cách tải về.
"""

import base64
import io
import json
import logging
import os
import socket
import sys
import threading
import traceback
import urllib.request
from pathlib import Path
from typing import Optional

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# ── Fix lỗi espeakng-loader trên Windows ──────────────────────────────────────
# Gói espeakng-loader đóng gói sẵn 1 bản libespeak-ng có lỗi: nó luôn cố mở
# dữ liệu tại 1 đường dẫn được biên dịch cứng từ máy build của tác giả gói
# (".../_dynamic/share/espeak-ng-data\phontab") bất kể ta gọi set_data_path()
# hay không (lỗi đã được nhiều dự án khác xác nhận, không phải do cấu hình).
# => Cách chắc chắn nhất là dùng bản eSpeak NG cài đặt thật (installer .msi
# chính chủ) rồi trỏ thẳng phonemizer vào đó, bỏ qua espeakng-loader.
_ESPEAK_CANDIDATES = [
    (r"C:\Program Files\eSpeak NG\libespeak-ng.dll", r"C:\Program Files\eSpeak NG\espeak-ng-data"),
    (r"C:\Program Files (x86)\eSpeak NG\libespeak-ng.dll", r"C:\Program Files (x86)\eSpeak NG\espeak-ng-data"),
]

def _setup_espeak():
    try:
        from phonemizer.backend.espeak.wrapper import EspeakWrapper
    except Exception as e:
        logger.debug("Bo qua thiet lap espeak-ng (chua cai phonemizer): %s", e)
        return

    has_set_data_path = hasattr(EspeakWrapper, "set_data_path")

    # 1) Uu tien ban eSpeak NG that (cai qua .msi) neu co - on dinh hon.
    #    Tren Windows, ban DLL cai qua .msi tu doc duong dan du lieu tu
    #    Windows Registry (do trinh cai dat ghi vao) nen chi can set_library
    #    la du, KHONG bat buoc phai goi duoc set_data_path.
    for lib_path, data_path in _ESPEAK_CANDIDATES:
        if os.path.isfile(lib_path) and os.path.isdir(data_path):
            EspeakWrapper.set_library(lib_path)
            if has_set_data_path:
                EspeakWrapper.set_data_path(data_path)
            os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = lib_path
            os.environ["ESPEAK_DATA_PATH"] = data_path
            logger.info("Dung eSpeak NG (cai that) tai: %s", lib_path)
            return

    # 2) Fallback: espeakng-loader (co the loi tren mot so may Windows).
    try:
        import espeakng_loader
        EspeakWrapper.set_library(espeakng_loader.get_library_path())
        if has_set_data_path:
            EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
        os.environ.setdefault("PHONEMIZER_ESPEAK_LIBRARY", espeakng_loader.get_library_path())
        os.environ.setdefault("ESPEAK_DATA_PATH", espeakng_loader.get_data_path())
        logger.info("Dung espeakng-loader: %s", espeakng_loader.get_data_path())
    except Exception as e:
        logger.debug("Khong the thiet lap espeak-ng: %s", e)

_setup_espeak()


# static_folder=None: tắt route static tự động của Flask. Route static mặc định
# của Flask (đăng ký nội bộ khi khởi tạo) khớp CÙNG pattern "/<path:...>" với
# route tự viết bên dưới và được ưu tiên khớp trước, khiến mọi đường dẫn không
# đúng tên file tuyệt đối (vd "/epub2audiobook" thay vì "/epub2audiobook.html")
# bị nó trả 404 luôn, không bao giờ rơi xuống được logic fallback tự viết.
# Tắt hẳn để 2 route index()/static_files() bên dưới là nơi DUY NHẤT phục vụ
# file tĩnh, đảm bảo cả trang chính lẫn các trang multi-page (epub2audiobook...)
# đều được phục vụ đúng — kể cả khi chạy dưới dạng .exe (BUNDLE_DIR).
app = Flask(__name__, static_folder=None)
CORS(app)

# ── OPDS (Open Publication Distribution System) ───────────────────────────────
# Cho phép các app đọc sách hỗ trợ OPDS trên thiết bị KHÁC (cùng mạng LAN/WiFi)
# duyệt và TẢI trực tiếp thư viện Calibre qua http://<ip-may-nay>:<port>/opds/
# — tương tự tính năng "Content server" / OPDS có sẵn của Calibre.
from opds import opds_bp  # noqa: E402
app.register_blueprint(opds_bp)

# ── Đường dẫn ────────────────────────────────────────────────────────────────
# Khi chạy dưới dạng file .exe đóng gói bằng PyInstaller (--onefile), __file__
# trỏ vào thư mục tạm (sys._MEIPASS) sẽ bị xoá sau khi thoát ứng dụng, nên:
#   - BASE_DIR   (nơi lưu "voices/" — dữ liệu cần giữ lại lâu dài) => thư mục
#     chứa file .exe thật sự, để model tải về không bị mất giữa các lần chạy.
#   - BUNDLE_DIR (nơi chứa "dist/" — tài nguyên tĩnh chỉ đọc, đóng gói sẵn)
#     => thư mục giải nén tạm khi chạy .exe, hoặc thư mục mã nguồn khi chạy
#     bằng "python tts_server.py" bình thường.
def _base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def _bundle_dir() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent


BASE_DIR    = _base_dir()
BUNDLE_DIR  = _bundle_dir()
VOICES_DIR  = BASE_DIR / "voices"          # Piper .onnx models (rhasspy)
NGHITTS_DIR = BASE_DIR / "voices" / "nghitts"  # Nghi-TTS .onnx models (github.com/nghimestudio/nghitts)

VOICES_DIR.mkdir(exist_ok=True)
NGHITTS_DIR.mkdir(parents=True, exist_ok=True)

# ── Calibre library (trang /calibre-manager) ──────────────────────────────────
# Đường dẫn thư mục gốc thư viện Calibre mặc định. Server đọc trực tiếp file
# metadata.db + các file sách (epub/pdf/audio/cover) từ đây và phục vụ qua API
# bên dưới, để trang calibre-manager tự động tải thư viện mà KHÔNG cần người
# dùng chọn thư mục thủ công mỗi lần mở app. Đường dẫn có thể đổi qua nút
# "Chọn thư mục" trên trang (lưu lại vào calibre_config.json cạnh file server).
DEFAULT_CALIBRE_LIBRARY = r"D:\OneDrive - 365freeactives\Calibre Portable\WAKA.VN LIBRARY"
CALIBRE_CONFIG_PATH = BASE_DIR / "calibre_config.json"


def _load_calibre_config() -> dict:
    if CALIBRE_CONFIG_PATH.exists():
        try:
            return json.loads(CALIBRE_CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            logger.warning("Khong doc duoc calibre_config.json, dung mac dinh.")
    return {"library_path": DEFAULT_CALIBRE_LIBRARY}


def _save_calibre_config(cfg: dict) -> None:
    CALIBRE_CONFIG_PATH.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    # Đường dẫn thư viện có thể đã đổi -> xoá cache metadata.db cũ để lần
    # tìm kế tiếp (config mới) không trả nhầm kết quả đã cache của path cũ.
    _metadata_db_cache.clear()


def _calibre_library_path() -> Path:
    cfg = _load_calibre_config()
    return Path(cfg.get("library_path") or DEFAULT_CALIBRE_LIBRARY)


# ── Nhạc nền (Background music) cho trang đọc EPUB ────────────────────────
# Danh sách link YouTube nhạc nền được lưu lại lâu dài vào music_link.json
# (cạnh file server), tương tự cách calibre_config.json lưu đường dẫn thư
# viện. Trang đọc EPUB gọi GET /api/music-links lúc mở panel "Nhạc nền" để
# tự động tải ra danh sách đã lưu, và gọi POST /api/music-links mỗi khi
# người dùng thêm/sửa/xoá link để lưu lại.
MUSIC_LINKS_PATH = BASE_DIR / "music_link.json"

DEFAULT_MUSIC_LINKS = [
    {"id": "lofi-chill", "name": "Lofi Chill Beats", "url": "https://www.youtube.com/watch?v=jfKfPfyJRdk"},
    {"id": "rain-sounds", "name": "Tiếng mưa thư giãn", "url": "https://www.youtube.com/watch?v=q76bMs-NwRk"},
    {"id": "piano-relax", "name": "Piano thư giãn", "url": "https://www.youtube.com/watch?v=lCOF9LN_Zxs"},
]


def _load_music_links() -> list:
    if MUSIC_LINKS_PATH.exists():
        try:
            data = json.loads(MUSIC_LINKS_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("links"), list):
                return data["links"]
            if isinstance(data, list):
                return data
        except Exception:
            logger.warning("Khong doc duoc music_link.json, dung danh sach mac dinh.")
    _save_music_links(DEFAULT_MUSIC_LINKS)
    return DEFAULT_MUSIC_LINKS


def _save_music_links(links: list) -> None:
    MUSIC_LINKS_PATH.write_text(
        json.dumps({"links": links}, ensure_ascii=False, indent=2), encoding="utf-8"
    )


# Cache kết quả tìm metadata.db theo đường dẫn thư viện (str(root) -> Path|None).
# QUAN TRỌNG: /api/calibre/file bị gọi RẤT NHIỀU LẦN liên tiếp — mỗi bìa sách
# trên trang (có thể 48 cuốn/trang) và mỗi định dạng file (EPUB/PDF/MP3...)
# đều gọi hàm này một lần. Nếu không cache, mỗi request đều phải quét lại
# toàn bộ thư mục con (root.iterdir() + iterdir() của từng thư mục con) —
# với thư viện lớn, hoặc thư mục nằm trên ổ mạng/OneDrive (nơi mỗi lần liệt
# kê thư mục có thể phải chờ đồng bộ đám mây), hàng chục request cùng lúc
# như vậy sẽ dồn ứ và làm cả trang bị "đơ" (bìa sách không tải ra được, rồi
# lan sang việc mở chi tiết sách cũng bị treo vì trình duyệt giới hạn số kết
# nối đồng thời tới cùng 1 địa chỉ). Cache theo path, xoá khi đổi thư mục
# thư viện (xem _save_calibre_config).
_metadata_db_cache: dict = {}


def _find_calibre_metadata_db(root: Path) -> Optional[Path]:
    """Tìm metadata.db trong thư mục gốc, giống logic phía frontend
    (findMetadataDbHandle): ưu tiên ngay tại root, nếu không có thì dò xuống
    tối đa 2 cấp con để đỡ phải chọn đúng-đúng thư mục con chứa DB.

    Kết quả được cache theo đường dẫn thư viện — chỉ quét đĩa 1 lần, các lần
    gọi sau (rất nhiều, xem ghi chú ở _metadata_db_cache) dùng lại kết quả."""
    key = str(root)
    if key in _metadata_db_cache:
        return _metadata_db_cache[key]

    result = _find_calibre_metadata_db_uncached(root)
    _metadata_db_cache[key] = result
    return result


def _find_calibre_metadata_db_uncached(root: Path) -> Optional[Path]:
    if not root.is_dir():
        return None
    direct = root / "metadata.db"
    if direct.is_file():
        return direct
    try:
        for child in root.iterdir():
            if child.is_dir():
                candidate = child / "metadata.db"
                if candidate.is_file():
                    return candidate
                for grandchild in child.iterdir():
                    if grandchild.is_dir():
                        candidate2 = grandchild / "metadata.db"
                        if candidate2.is_file():
                            return candidate2
    except OSError:
        pass
    return None


# ── Piper voices ─────────────────────────────────────────────────────────────
AVAILABLE_VOICES = {
    "vais1000-medium": {
        "model": "vi_VN-vais1000-medium",
        "label": "VAIS1000 (Nữ - Chất lượng cao)",
        "speaker_id": None,
    },
    "vivos-x_low": {
        "model": "vi_VN-vivos-x_low",
        "label": "VIVOS (Đa giọng - Nhẹ)",
        "speaker_id": 0,
    },
    "25hours-low": {
        "model": "vi_VN-25hours_single-low",
        "label": "25 Hours (Nữ - Nhẹ)",
        "speaker_id": None,
    },
}
DEFAULT_VOICE = "vais1000-medium"
_piper_cache: dict = {}

# ── Nghi-TTS voices (github.com/nghimestudio/nghitts) ──────────────────────────
# Cùng định dạng Piper (.onnx + .onnx.json) nên tái sử dụng toàn bộ hàm suy luận
# Piper bên dưới, chỉ khác thư mục lưu model (NGHITTS_DIR) và cách tải về.
#
# Model do tác giả nghitts công bố công khai trên Google Drive (không có URL tải
# trực tiếp từng file ổn định như HuggingFace), nên:
#   - Danh sách dưới đây chỉ là "nhãn đẹp" cho các model đã biết tên (tùy chọn).
#   - App LUÔN tự động quét toàn bộ *.onnx trong voices/nghitts/ khi khởi động,
#     vì vậy bất kỳ model nghitts nào (kể cả các bản mới sau này: Mỹ Tâm, Trấn
#     Thành, Ngọc Huyền, Oryx...) chỉ cần copy 2 file .onnx + .onnx.json vào
#     đúng thư mục là tự xuất hiện trong danh sách giọng đọc, không cần sửa code.
NGHITTS_KNOWN_LABELS = {
    "calmwoman3688": "Nghi-TTS — Nữ nhẹ nhàng (Calm Woman)",
    "deepman3909":   "Nghi-TTS — Nam trầm (Deep Man)",
    "ngocngan3701":  "Nghi-TTS — Ngọc Ngân",
    "vietthao3886":  "Nghi-TTS — Việt Thảo",
    "mytam":         "Nghi-TTS — Mỹ Tâm",
    "tranthanh":     "Nghi-TTS — Trấn Thành",
    "ngochuyen":     "Nghi-TTS — Ngọc Huyền (review phim)",
    "oryx":          "Nghi-TTS — Oryx (Nam siêu trầm)",
}
# Thư mục Google Drive công khai chứa toàn bộ model nghitts (từ README dự án).
NGHITTS_GDRIVE_FOLDER = "https://drive.google.com/drive/folders/1f_pCpvgqfvO4fdNKM7WS4zTuXC0HBskL"
_nghitts_cache: dict = {}


def prettify_voice_name(name: str) -> str:
    """Suy ra nhãn hiển thị từ tên file khi không có trong NGHITTS_KNOWN_LABELS."""
    label = name.replace("_", " ").replace("-", " ").strip()
    # Bỏ hậu tố số kiểu "3688", "3909" nếu có (mã định danh nội bộ của nghitts)
    import re
    label = re.sub(r"\s*\d{3,}$", "", label).strip()
    return f"Nghi-TTS — {label.title()}" if label else f"Nghi-TTS — {name}"


def discover_nghitts_voices() -> dict:
    """Quét voices/nghitts/ và trả về registry {voice_key: {model,label,speaker_id}}
    cho mọi cặp file <name>.onnx + <name>.onnx.json tìm thấy."""
    found = {}
    if not NGHITTS_DIR.exists():
        return found
    for onnx_path in sorted(NGHITTS_DIR.glob("*.onnx")):
        name = onnx_path.stem
        cfg_path = Path(str(onnx_path) + ".json")
        if not cfg_path.exists():
            continue
        label = NGHITTS_KNOWN_LABELS.get(name, prettify_voice_name(name))
        speaker_id = None
        try:
            cfg = json.loads(cfg_path.read_text())
            if cfg.get("num_speakers", 1) and cfg.get("num_speakers", 1) > 1:
                speaker_id = 0  # mặc định speaker đầu tiên cho model multi-speaker
        except Exception:
            pass
        found[name] = {"model": name, "label": label, "speaker_id": speaker_id}
    return found

# ─────────────────────────────────────────────────────────────────────────────
# Piper helpers
# ─────────────────────────────────────────────────────────────────────────────

def get_piper_model_path(voice_key: str) -> Optional[Path]:
    info = AVAILABLE_VOICES.get(voice_key)
    if not info:
        return None
    p = VOICES_DIR / f"{info['model']}.onnx"
    return p if p.exists() else None


def load_piper_voice(voice_key: str):
    if voice_key in _piper_cache:
        return _piper_cache[voice_key]
    model_path = get_piper_model_path(voice_key)
    if model_path is None:
        raise FileNotFoundError(f"Model Piper '{voice_key}' chưa được tải.")
    from piper.voice import PiperVoice
    logger.info("Load Piper model: %s", model_path)
    voice = PiperVoice.load(str(model_path), use_cuda=False)
    _piper_cache[voice_key] = voice
    return voice


def get_piper_sample_rate(voice_key: str) -> int:
    model_path = get_piper_model_path(voice_key)
    if model_path is None:
        return 22050
    cfg = Path(str(model_path) + ".json")
    if cfg.exists():
        try:
            return json.loads(cfg.read_text())["audio"]["sample_rate"]
        except Exception:
            pass
    return 22050


def synthesize_piper(text: str, voice_key: str, speed: float) -> tuple[str, int]:
    from piper import SynthesisConfig
    voice = load_piper_voice(voice_key)
    info  = AVAILABLE_VOICES[voice_key]
    cfg   = SynthesisConfig(
        length_scale=1.0 / max(speed, 0.1),
        speaker_id=info.get("speaker_id"),
    )
    chunks = []
    for chunk in voice.synthesize(text, syn_config=cfg):
        chunks.append(chunk.audio_int16_bytes)
    if not chunks:
        raise RuntimeError("Piper không tạo được âm thanh.")
    raw = b"".join(chunks)
    sr  = get_piper_sample_rate(voice_key)
    return base64.b64encode(raw).decode(), sr


# ─────────────────────────────────────────────────────────────────────────────
# Nghi-TTS helpers (github.com/nghimestudio/nghitts — Piper-compatible ONNX)
# ─────────────────────────────────────────────────────────────────────────────

def get_nghitts_model_path(voice_key: str) -> Optional[Path]:
    registry = discover_nghitts_voices()
    info = registry.get(voice_key)
    if not info:
        return None
    p = NGHITTS_DIR / f"{info['model']}.onnx"
    return p if p.exists() else None


def load_nghitts_voice(voice_key: str):
    if voice_key in _nghitts_cache:
        return _nghitts_cache[voice_key]
    model_path = get_nghitts_model_path(voice_key)
    if model_path is None:
        raise FileNotFoundError(f"Model Nghi-TTS '{voice_key}' chưa được tải.")
    from piper.voice import PiperVoice
    logger.info("Load Nghi-TTS model: %s", model_path)
    voice = PiperVoice.load(str(model_path), use_cuda=False)
    _nghitts_cache[voice_key] = voice
    return voice


def get_nghitts_sample_rate(voice_key: str) -> int:
    model_path = get_nghitts_model_path(voice_key)
    if model_path is None:
        return 22050
    cfg = Path(str(model_path) + ".json")
    if cfg.exists():
        try:
            return json.loads(cfg.read_text())["audio"]["sample_rate"]
        except Exception:
            pass
    return 22050


def synthesize_nghitts(text: str, voice_key: str, speed: float) -> tuple[str, int]:
    from piper import SynthesisConfig
    voice    = load_nghitts_voice(voice_key)
    registry = discover_nghitts_voices()
    info     = registry.get(voice_key, {})
    cfg      = SynthesisConfig(
        length_scale=1.0 / max(speed, 0.1),
        speaker_id=info.get("speaker_id"),
    )
    chunks = []
    for chunk in voice.synthesize(text, syn_config=cfg):
        chunks.append(chunk.audio_int16_bytes)
    if not chunks:
        raise RuntimeError("Nghi-TTS không tạo được âm thanh.")
    raw = b"".join(chunks)
    sr  = get_nghitts_sample_rate(voice_key)
    return base64.b64encode(raw).decode(), sr


def download_nghitts_voices(verbose: bool = True) -> bool:
    """Tải toàn bộ thư mục model Nghi-TTS công khai từ Google Drive về
    voices/nghitts/. Cần thư viện `gdown` (đã có trong requirements.txt).
    Sau khi tải xong, các model sẽ tự động được app phát hiện — không cần
    khai báo tên model theo cách thủ công."""
    try:
        import gdown
    except ImportError:
        print("Thieu thu vien 'gdown'. Cai bang: pip install gdown")
        return False

    NGHITTS_DIR.mkdir(parents=True, exist_ok=True)
    if verbose:
        print(f"Dang tai model Nghi-TTS tu Google Drive vao: {NGHITTS_DIR}")
        print("(co the mat vai phut tuy so luong va dung luong model)")
    try:
        gdown.download_folder(
            url=NGHITTS_GDRIVE_FOLDER,
            output=str(NGHITTS_DIR),
            quiet=not verbose,
            use_cookies=False,
        )
    except Exception as e:
        print(f"Loi tai model Nghi-TTS: {e}")
        print("Ban co the tai thu cong tai:")
        print(f"  {NGHITTS_GDRIVE_FOLDER}")
        print(f"roi copy cap file <ten>.onnx + <ten>.onnx.json vao: {NGHITTS_DIR}")
        return False

    found = discover_nghitts_voices()
    if not found:
        print("Khong tim thay cap file .onnx/.onnx.json hop le sau khi tai.")
        return False
    if verbose:
        print(f"Da san sang {len(found)} giong Nghi-TTS:")
        for k, v in found.items():
            print(f"  - {k}: {v['label']}")
    return True


def download_piper_voice(voice_key: str) -> bool:
    info = AVAILABLE_VOICES.get(voice_key)
    if not info:
        print(f"Giọng không hợp lệ: {voice_key}")
        return False
    model_name = info["model"]
    parts      = model_name.split("-", 1)
    lang_code  = parts[0]
    rest       = parts[1]
    last_dash  = rest.rfind("-")
    voice_name = rest[:last_dash]
    quality    = rest[last_dash + 1:]
    lang_fam   = lang_code.split("_")[0]
    base_url   = (
        f"https://huggingface.co/rhasspy/piper-voices/resolve/main"
        f"/{lang_fam}/{lang_code}/{voice_name}/{quality}"
        f"/{lang_code}-{voice_name}-{quality}"
    )
    for ext in [".onnx", ".onnx.json"]:
        dest = VOICES_DIR / f"{model_name}{ext}"
        if dest.exists() and dest.stat().st_size > 1000:
            print(f"Da co san: {dest.name}")
            continue
        print(f"Dang tai: {dest.name}")
        try:
            urllib.request.urlretrieve(base_url + ext + "?download=true", str(dest))
            print(f"Da tai: {dest.name} ({dest.stat().st_size // 1024} KB)")
        except Exception as e:
            print(f"Loi tai {dest.name}: {e}")
            return False
    return True


# ─────────────────────────────────────────────────────────────────────────────
# Flask routes
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/api/tts")
def tts():
    """
    POST /api/tts
    Body: {
      "text": "...",
      "engine": "piper" | "nghitts",              (default: piper)
      "voice": "<piper_hoặc_nghitts_voice_key>",
      "speed": 1.0
    }
    Response: { "audio": "<base64 int16 PCM>", "sampleRate": <int> }
    """
    data   = request.get_json(silent=True) or {}
    text   = (data.get("text") or "").strip()
    engine = data.get("engine", "piper")
    speed  = float(data.get("speed", 1.0))

    if not text:
        return jsonify({"error": "Thiếu trường 'text'"}), 400

    try:
        if engine == "nghitts":
            voice_key = data.get("voice", "")
            if get_nghitts_model_path(voice_key) is None:
                return jsonify({
                    "error": f"Model Nghi-TTS '{voice_key}' chưa tải. "
                             f"Chạy: python tts_server.py --download-nghitts"
                }), 503
            audio_b64, sr = synthesize_nghitts(text, voice_key, speed)
        else:
            voice_key = data.get("voice", DEFAULT_VOICE)
            if voice_key not in AVAILABLE_VOICES:
                voice_key = DEFAULT_VOICE
            if get_piper_model_path(voice_key) is None:
                return jsonify({"error": f"Model Piper '{voice_key}' chưa tải. Chạy start.bat để tải."}), 503
            audio_b64, sr = synthesize_piper(text, voice_key, speed)

        return jsonify({"audio": audio_b64, "sampleRate": sr})

    except Exception as e:
        logger.exception("Loi TTS")
        return jsonify({"error": str(e)}), 500


@app.get("/api/voices")
def list_voices():
    result = {}
    for key, info in AVAILABLE_VOICES.items():
        result[f"piper:{key}"] = {
            "label":      info["label"],
            "engine":     "piper",
            "voice_key":  key,
            "downloaded": get_piper_model_path(key) is not None,
        }
    for key, info in discover_nghitts_voices().items():
        result[f"nghitts:{key}"] = {
            "label":      info["label"],
            "engine":     "nghitts",
            "voice_key":  key,
            "downloaded": True,  # đã quét được file trên đĩa nên chắc chắn có sẵn
        }
    return jsonify(result)


@app.get("/api/health")
def health():
    return jsonify({
        "status":    "ok",
        "piper":     any(get_piper_model_path(k) for k in AVAILABLE_VOICES),
        "nghitts":   len(discover_nghitts_voices()) > 0,
    })


@app.get("/api/calibre/config")
def calibre_get_config():
    """Trả về đường dẫn thư viện Calibre hiện tại và trạng thái (có tìm thấy
    metadata.db hay không) — trang calibre-manager gọi cái này lúc khởi động
    để tự tải thư viện mà không cần người dùng chọn thư mục."""
    cfg = _load_calibre_config()
    path = cfg.get("library_path") or DEFAULT_CALIBRE_LIBRARY
    root = Path(path)
    db_path = _find_calibre_metadata_db(root)
    return jsonify({
        "path": path,
        "exists": root.is_dir(),
        "valid": db_path is not None,
    })


@app.post("/api/calibre/config")
def calibre_set_config():
    """Đổi thư mục thư viện Calibre (lưu lại lâu dài vào calibre_config.json)."""
    data = request.get_json(silent=True) or {}
    new_path = (data.get("path") or "").strip()
    if not new_path:
        return jsonify({"error": "Thiếu đường dẫn thư mục"}), 400
    cfg = _load_calibre_config()
    cfg["library_path"] = new_path
    _save_calibre_config(cfg)
    root = Path(new_path)
    db_path = _find_calibre_metadata_db(root)
    return jsonify({
        "path": new_path,
        "exists": root.is_dir(),
        "valid": db_path is not None,
    })


@app.get("/api/music-links")
def music_get_links():
    """Trả về danh sách link nhạc nền (đọc từ music_link.json, tự tạo file
    với vài link mặc định nếu chưa tồn tại) — panel "Nhạc nền" trên trang
    đọc EPUB gọi cái này lúc mở panel để tự động tải ra danh sách đã lưu."""
    return jsonify({"links": _load_music_links()})


@app.post("/api/music-links")
def music_set_links():
    """Lưu lại toàn bộ danh sách link nhạc nền vào music_link.json — gọi mỗi
    khi người dùng thêm/xoá link trong panel "Nhạc nền"."""
    data = request.get_json(silent=True) or {}
    links = data.get("links")
    if not isinstance(links, list):
        return jsonify({"error": "Thiếu danh sách links"}), 400
    _save_music_links(links)
    return jsonify({"links": links})


@app.post("/api/calibre/browse-folder")
def calibre_browse_folder():
    """Mở hộp thoại chọn thư mục GỐC của hệ điều hành (trên máy đang chạy
    server) để người dùng chọn thư viện Calibre — thay cho picker giới hạn
    của trình duyệt, và cho phép bắt đầu ngay tại thư mục đang dùng."""
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as e:
        return jsonify({"ok": False, "error": f"Không mở được hộp thoại chọn thư mục (thiếu tkinter): {e}"}), 500

    cfg = _load_calibre_config()
    current = cfg.get("library_path") or DEFAULT_CALIBRE_LIBRARY
    initial_dir = current if Path(current).is_dir() else str(Path.home())

    result: dict = {}

    def _run_dialog():
        try:
            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            chosen = filedialog.askdirectory(
                initialdir=initial_dir, title="Chọn thư mục thư viện Calibre"
            )
            root.destroy()
            result["path"] = chosen
        except Exception as e:  # noqa: BLE001
            result["error"] = str(e)

    # tkinter cần mainloop riêng của nó -> chạy trên 1 thread, đợi xong rồi
    # mới trả kết quả (thao tác này do người dùng chủ động bấm nên chặn một
    # request ngắn là chấp nhận được).
    t = threading.Thread(target=_run_dialog, daemon=True)
    t.start()
    t.join()

    if result.get("error"):
        return jsonify({"ok": False, "error": result["error"]}), 500
    chosen = result.get("path")
    if not chosen:
        return jsonify({"ok": True, "cancelled": True})
    return jsonify({"ok": True, "path": chosen})


@app.get("/api/calibre/metadata.db")
def calibre_metadata_db():
    """Phục vụ trực tiếp file metadata.db của thư viện Calibre hiện tại."""
    root = _calibre_library_path()
    db_path = _find_calibre_metadata_db(root)
    if not db_path:
        return jsonify({"error": "Không tìm thấy metadata.db trong thư mục thư viện đã cấu hình"}), 404
    resp = send_from_directory(str(db_path.parent), db_path.name)
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/api/calibre/file")
def calibre_file():
    """Phục vụ 1 file bất kỳ (bìa sách, epub/pdf/audio) bên trong thư viện
    Calibre, theo đường dẫn tương đối 'rel' (giống bookPath/filename.ext mà
    Calibre dùng). Có kiểm tra chống path traversal ra ngoài thư mục thư viện."""
    rel = request.args.get("rel", "")
    if not rel:
        return jsonify({"error": "Thiếu tham số rel"}), 400

    root = _calibre_library_path()
    db_path = _find_calibre_metadata_db(root)
    # Các file sách nằm cùng thư mục chứa metadata.db (đường dẫn book.path là
    # tương đối so với thư mục đó), nên dùng thư mục của DB làm gốc thay vì
    # `root` thẳng, phòng trường hợp DB nằm trong 1 thư mục con của root.
    base = db_path.parent if db_path else root

    try:
        base_resolved = base.resolve(strict=True)
        target = (base_resolved / rel).resolve()
        target.relative_to(base_resolved)  # ném lỗi nếu target nằm ngoài base
    except Exception:
        return jsonify({"error": "Đường dẫn không hợp lệ"}), 400

    if not target.is_file():
        return jsonify({"error": "Không tìm thấy file"}), 404

    return send_from_directory(str(target.parent), target.name)


def _get_lan_ip() -> str:
    """Xác định địa chỉ IP LAN thật của máy này (không phải 127.0.0.1), bằng
    cách mở 1 socket UDP "giả" tới DNS công cộng (8.8.8.8) — KHÔNG gửi dữ liệu
    thật đi, chỉ mượn bước này để hệ điều hành chọn ra network interface/IP
    LAN đang hoạt động (card WiFi/LAN đang dùng để ra Internet). Nếu máy
    không có kết nối mạng nào, trả về 127.0.0.1 để không lỗi."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


@app.get("/api/server-info")
def server_info():
    """Trả về địa chỉ IP LAN + port thật của server hiện tại — trang
    calibre-manager gọi API này để hiển thị ĐÚNG địa chỉ OPDS (thay vì
    "localhost") khi người dùng mở app ngay trên máy chủ."""
    host_header = request.host  # ví dụ "localhost:3000" hoặc "192.168.1.5:3000"
    port = host_header.rsplit(":", 1)[-1] if ":" in host_header else "3000"
    return jsonify({"lan_ip": _get_lan_ip(), "port": port})


@app.get("/")
def index():
    dist = BUNDLE_DIR / "dist"
    if dist.exists():
        return send_from_directory(str(dist), "index.html")
    return "<h2>Chay: npm run build de build frontend.</h2>", 200


@app.get("/<path:path>")
def static_files(path):
    dist = BUNDLE_DIR / "dist"
    if not dist.exists():
        return "Not found", 404

    # File tĩnh có thật (js, css, ảnh, ...)
    if (dist / path).is_file():
        return send_from_directory(str(dist), path)

    # Trang multi-page (build ra <ten>.html), truy cập không cần đuôi .html
    # Vd: /epub2audiobook -> dist/epub2audiobook.html
    html_candidate = f"{path.rstrip('/')}.html"
    if (dist / html_candidate).is_file():
        return send_from_directory(str(dist), html_candidate)

    # Fallback: trang đọc chính (SPA)
    return send_from_directory(str(dist), "index.html")


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="EPUB TTS Server (Piper + Nghi-TTS)")
    parser.add_argument("--download",           metavar="VOICE", help="Tai Piper voice (vd: vais1000-medium)")
    parser.add_argument("--download-all",       action="store_true", help="Tai tat ca Piper voices")
    parser.add_argument("--download-nghitts",   action="store_true", help="Tai toan bo model Nghi-TTS (nghimestudio/nghitts) tu Google Drive")
    parser.add_argument("--list",               action="store_true", help="Liet ke tat ca giong doc")
    parser.add_argument("--port",  type=int, default=3000)
    parser.add_argument("--host",  default="127.0.0.1")
    args = parser.parse_args()

    if args.list:
        print("\nPiper voices:")
        for k, v in AVAILABLE_VOICES.items():
            st = "OK" if get_piper_model_path(k) else "chua tai"
            print(f"  {k:25s} [{st}]  {v['label']}")
        nghitts_found = discover_nghitts_voices()
        print("\nNghi-TTS voices:")
        if nghitts_found:
            for k, v in nghitts_found.items():
                print(f"  {k:25s} [OK]  {v['label']}")
        else:
            print("  (chua co model nao. Chay: python tts_server.py --download-nghitts)")
        sys.exit(0)

    if args.download:
        sys.exit(0 if download_piper_voice(args.download) else 1)

    if args.download_all:
        for k in AVAILABLE_VOICES:
            download_piper_voice(k)
        sys.exit(0)

    if args.download_nghitts:
        print("\nDang tai model Nghi-TTS (nghimestudio/nghitts) tu Google Drive...")
        ok = download_nghitts_voices(verbose=True)
        sys.exit(0 if ok else 1)

    # ── Khởi động server ──────────────────────────────────────────────────────
    # Tải Piper nếu chưa có
    piper_ok = any(get_piper_model_path(k) for k in AVAILABLE_VOICES)
    if not piper_ok:
        print("\nDang tai Piper model mac dinh (vais1000-medium)...")
        ok = download_piper_voice(DEFAULT_VOICE)
        if not ok:
            print("Khong tai duoc Piper model. Server van chay nhung TTS se bao loi.")

    # Preload Piper mặc định nếu có
    if get_piper_model_path(DEFAULT_VOICE):
        try:
            load_piper_voice(DEFAULT_VOICE)
        except Exception as e:
            logger.warning("Khong preload Piper: %s", e)

    # Preload giọng Nghi-TTS đầu tiên (nếu người dùng đã tải/đặt sẵn model)
    nghitts_voices = discover_nghitts_voices()
    if nghitts_voices:
        first_key = next(iter(nghitts_voices))
        try:
            load_nghitts_voice(first_key)
        except Exception as e:
            logger.warning("Khong preload Nghi-TTS: %s", e)

    print(f"\nTTS Server dang chay tai http://{args.host}:{args.port}")
    print(f"  Piper    : {'SAN SANG' if piper_ok else 'CHUA CO MODEL'}")
    print(f"  Nghi-TTS : {'SAN SANG (' + str(len(nghitts_voices)) + ' giong)' if nghitts_voices else 'CHUA CO MODEL (chay --download-nghitts)'}")
    print(f"\nMo trinh duyet: http://localhost:{args.port}")
    print("Nhan Ctrl+C de dung.\n")

    app.run(host=args.host, port=args.port, debug=False, threaded=True)
