"""
OPDS (Open Publication Distribution System) cho thư viện Calibre.

Cho phép các app đọc sách hỗ trợ chuẩn OPDS (KOReader, Moon+ Reader, FBReader,
Calibre Companion, PocketBook, Marvin, ...) trên điện thoại/máy tính bảng KHÁC
— cùng mạng WiFi/LAN với máy đang chạy server này — kết nối vào, duyệt danh
mục (theo tất cả sách / tác giả / bộ sách / thể loại / mới thêm / tìm kiếm) và
TẢI file sách (epub/pdf/...) + bìa sách trực tiếp. Tương đương tính năng
"Content server" / OPDS có sẵn của Calibre, nhưng chạy ngay trong server nhẹ
này, không cần cài đặt/khởi động Calibre.

Cách hoạt động: đọc trực tiếp metadata.db bằng module `sqlite3` chuẩn của
Python (không cần cài thêm gói nào), map ra XML theo chuẩn Atom + OPDS 1.2,
và trỏ các link tải file vào route có sẵn GET /api/calibre/file?rel=... của
tts_server.py (route đó vốn dùng cho trang /calibre-manager, có sẵn kiểm tra
chống path traversal).

Cách đăng ký (đã được thêm sẵn trong tts_server.py):
    from opds import opds_bp
    app.register_blueprint(opds_bp)
"""

import json
import re
import sqlite3
import sys
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape as xesc

from flask import Blueprint, Response, request

opds_bp = Blueprint("opds", __name__, url_prefix="/opds")


# ── Đường dẫn thư viện Calibre ────────────────────────────────────────────────
# Đọc lại đúng file calibre_config.json mà tts_server.py dùng (do người dùng
# đổi qua trang /calibre-manager), để không phải đồng bộ 2 nơi cấu hình khác
# nhau — người dùng chỉ cần chọn thư mục thư viện 1 lần duy nhất.
def _base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


BASE_DIR = _base_dir()
CALIBRE_CONFIG_PATH = BASE_DIR / "calibre_config.json"
DEFAULT_CALIBRE_LIBRARY = r"D:\OneDrive - 365freeactives\Calibre Portable\WAKA.VN LIBRARY"


def _load_calibre_config() -> dict:
    if CALIBRE_CONFIG_PATH.exists():
        try:
            return json.loads(CALIBRE_CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"library_path": DEFAULT_CALIBRE_LIBRARY}


def _calibre_library_path() -> Path:
    return Path(_load_calibre_config().get("library_path") or DEFAULT_CALIBRE_LIBRARY)


def _find_calibre_metadata_db(root: Path):
    """Giống hệt logic trong tts_server.py: ưu tiên metadata.db ngay tại root,
    nếu không có thì dò xuống tối đa 2 cấp con."""
    if not root.is_dir():
        return None
    direct = root / "metadata.db"
    if direct.is_file():
        return direct
    try:
        for child in root.iterdir():
            if child.is_dir():
                c = child / "metadata.db"
                if c.is_file():
                    return c
                for gc in child.iterdir():
                    if gc.is_dir():
                        c2 = gc / "metadata.db"
                        if c2.is_file():
                            return c2
    except OSError:
        pass
    return None


def _get_conn():
    """Mở 1 kết nối sqlite3 mới cho mỗi request (connection sqlite3 không nên
    dùng chung giữa nhiều request Flask/thread), ở chế độ chỉ đọc. Trả về
    None nếu chưa tìm thấy metadata.db (chưa cấu hình / sai đường dẫn)."""
    root = _calibre_library_path()
    db_path = _find_calibre_metadata_db(root)
    if not db_path:
        return None
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


# ── Định dạng file & MIME type ────────────────────────────────────────────────
FORMAT_MIME = {
    "EPUB": "application/epub+zip",
    "PDF": "application/pdf",
    "MOBI": "application/x-mobipocket-ebook",
    "AZW": "application/vnd.amazon.ebook",
    "AZW3": "application/vnd.amazon.ebook",
    "FB2": "application/x-fictionbook+xml",
    "TXT": "text/plain",
    "CBZ": "application/x-cbz",
    "CBR": "application/x-cbr",
    "DOCX": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "RTF": "application/rtf",
    "HTMLZ": "application/zip",
    "ZIP": "application/zip",
}

NAV_TYPE = "application/atom+xml;profile=opds-catalog;kind=navigation"
ACQ_TYPE = "application/atom+xml;profile=opds-catalog;kind=acquisition"
PAGE_SIZE = 40

XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n'


def _file_url(rel: str) -> str:
    """Dùng lại route GET /api/calibre/file?rel=... đã có sẵn trong
    tts_server.py để phục vụ file (đã có kiểm tra chống path traversal)."""
    return f"/api/calibre/file?rel={quote(rel, safe='')}"


def _abs(href: str) -> str:
    """Đổi 1 href tương đối (bắt đầu bằng /) thành URL tuyệt đối, để các app
    OPDS đơn giản (không tự resolve URL tương đối đúng chuẩn) vẫn tải được."""
    return request.host_url.rstrip("/") + href


def _iso_time(value) -> str:
    if not value:
        return "2020-01-01T00:00:00+00:00"
    s = str(value).replace(" ", "T")
    if "+" not in s and "Z" not in s:
        s += "+00:00"
    return s


# ── Truy vấn sách (dùng chung 1 khung, khác nhau ở WHERE / ORDER BY) ─────────
BOOK_QUERY = """
SELECT b.id, b.title, b.author_sort, b.path, b.has_cover, b.pubdate,
       b.timestamp, b.last_modified, b.series_index, b.uuid,
       GROUP_CONCAT(DISTINCT a.name) as authors,
       GROUP_CONCAT(DISTINCT t.name) as tags,
       p.name as publisher,
       s.name as series,
       l.lang_code as lang,
       c.text as comments
FROM books b
LEFT JOIN books_authors_link bal ON bal.book = b.id
LEFT JOIN authors a ON a.id = bal.author
LEFT JOIN books_tags_link btl ON btl.book = b.id
LEFT JOIN tags t ON t.id = btl.tag
LEFT JOIN books_publishers_link bpl ON bpl.book = b.id
LEFT JOIN publishers p ON p.id = bpl.publisher
LEFT JOIN books_series_link bsl ON bsl.book = b.id
LEFT JOIN series s ON s.id = bsl.series
LEFT JOIN books_languages_link bll ON bll.book = b.id
LEFT JOIN languages l ON l.id = bll.lang_code
LEFT JOIN comments c ON c.book = b.id
{where}
GROUP BY b.id
ORDER BY {order}
LIMIT ? OFFSET ?
"""


def _query_books(conn, where="", params=(), order="b.title COLLATE NOCASE ASC", offset=0, limit=PAGE_SIZE):
    sql = BOOK_QUERY.format(where=where, order=order)
    rows = conn.execute(sql, (*params, limit + 1, offset)).fetchall()
    has_more = len(rows) > limit
    return rows[:limit], has_more


def _book_files(conn, book_id):
    return conn.execute(
        "SELECT format, name FROM data WHERE book = ? ORDER BY format", (book_id,)
    ).fetchall()


def _entry_xml(conn, row) -> str:
    title = row["title"] or "(Không có tên)"
    authors_raw = row["authors"] or row["author_sort"] or ""
    author_names = [a.strip() for a in authors_raw.split(",") if a.strip()]
    updated = _iso_time(row["last_modified"] or row["timestamp"] or row["pubdate"])

    summary = row["comments"] or ""
    summary_text = re.sub("<[^<]+?>", " ", summary)
    summary_text = re.sub(r"\s+", " ", summary_text).strip()
    prefix_bits = []
    if row["series"]:
        idx = row["series_index"]
        idx_txt = f" #{idx:g}" if isinstance(idx, (int, float)) else ""
        prefix_bits.append(f"Bộ sách: {row['series']}{idx_txt}")
    if row["publisher"]:
        prefix_bits.append(f"NXB: {row['publisher']}")
    if prefix_bits:
        summary_text = " | ".join(prefix_bits) + (" — " + summary_text if summary_text else "")
    summary_text = summary_text[:2000]

    links = []
    if row["has_cover"]:
        cover_url = _abs(_file_url(f'{row["path"]}/cover.jpg'))
        links.append(f'<link rel="http://opds-spec.org/image" href="{xesc(cover_url)}" type="image/jpeg"/>')
        links.append(f'<link rel="http://opds-spec.org/image/thumbnail" href="{xesc(cover_url)}" type="image/jpeg"/>')

    for f in _book_files(conn, row["id"]):
        fmt = (f["format"] or "").upper()
        if not fmt:
            continue
        rel = f'{row["path"]}/{f["name"]}.{fmt.lower()}'
        mime = FORMAT_MIME.get(fmt, "application/octet-stream")
        href = _abs(_file_url(rel))
        links.append(
            f'<link rel="http://opds-spec.org/acquisition" href="{xesc(href)}" '
            f'type="{xesc(mime)}" title="Tải {xesc(fmt)}"/>'
        )

    cats_xml = "".join(
        f'<category term="{xesc(tag.strip())}" label="{xesc(tag.strip())}"/>'
        for tag in (row["tags"] or "").split(",") if tag.strip()
    )
    authors_xml = "".join(f"<author><name>{xesc(n)}</name></author>" for n in author_names)
    lang_xml = f'<dc:language>{xesc(row["lang"])}</dc:language>' if row["lang"] else ""

    return (
        "<entry>"
        f"<id>urn:uuid:{xesc(row['uuid'] or str(row['id']))}</id>"
        f"<title>{xesc(title)}</title>"
        f"<updated>{xesc(updated)}</updated>"
        f"{authors_xml}"
        f"{cats_xml}"
        f"{lang_xml}"
        f'<summary type="text">{xesc(summary_text)}</summary>'
        f"{''.join(links)}"
        "</entry>"
    )


# ── Khung feed Atom/OPDS chung ────────────────────────────────────────────────
def _feed(title: str, feed_id: str, entries_xml: str, self_href: str, feed_type: str, extra_links: str = "") -> Response:
    xml = (
        XML_HEADER
        + '<feed xmlns="http://www.w3.org/2005/Atom" '
        + 'xmlns:opds="http://opds-spec.org/2010/catalog" '
        + 'xmlns:dc="http://purl.org/dc/terms/">'
        + f"<id>{xesc(feed_id)}</id>"
        + f"<title>{xesc(title)}</title>"
        + f"<updated>{xesc(_iso_time(None))}</updated>"
        + '<author><name>Sách Nói EPUB</name></author>'
        + f'<link rel="self" href="{xesc(_abs(self_href))}" type="{xesc(feed_type)}"/>'
        + f'<link rel="start" href="{xesc(_abs("/opds/"))}" type="{xesc(NAV_TYPE)}"/>'
        + f'<link rel="search" href="{xesc(_abs("/opds/opensearch.xml"))}" type="application/opensearchdescription+xml"/>'
        + extra_links
        + entries_xml
        + "</feed>"
    )
    return Response(xml, mimetype=feed_type + "; charset=utf-8")


def _no_library_feed():
    entry = (
        "<entry>"
        "<id>urn:uuid:no-library-configured</id>"
        "<title>Chưa tìm thấy thư viện Calibre</title>"
        f"<updated>{xesc(_iso_time(None))}</updated>"
        '<summary type="text">Hãy mở trang /calibre-manager trên máy chủ và chọn thư mục thư viện Calibre trước, sau đó tải lại danh mục OPDS này.</summary>'
        "</entry>"
    )
    return _feed("Sách Nói EPUB — OPDS", "urn:opds:no-library", entry, "/opds/", NAV_TYPE)


def _paging_links(base_path: str, offset: int, has_more: bool, extra_qs: str = "") -> str:
    links = []
    sep = "&" if extra_qs else ""
    if offset > 0:
        prev_off = max(0, offset - PAGE_SIZE)
        links.append(f'<link rel="previous" href="{xesc(_abs(f"{base_path}?offset={prev_off}{sep}{extra_qs}"))}" type="{xesc(ACQ_TYPE)}"/>')
    if has_more:
        next_off = offset + PAGE_SIZE
        links.append(f'<link rel="next" href="{xesc(_abs(f"{base_path}?offset={next_off}{sep}{extra_qs}"))}" type="{xesc(ACQ_TYPE)}"/>')
    return "".join(links)


def _nav_entry(title: str, nav_id: str, href: str, content: str = "") -> str:
    return (
        "<entry>"
        f"<id>{xesc(nav_id)}</id>"
        f"<title>{xesc(title)}</title>"
        f"<updated>{xesc(_iso_time(None))}</updated>"
        f'<content type="text">{xesc(content)}</content>'
        f'<link rel="subsection" href="{xesc(_abs(href))}" type="{xesc(NAV_TYPE)}"/>'
        "</entry>"
    )


# ── Routes ────────────────────────────────────────────────────────────────────
@opds_bp.get("/")
def opds_root():
    conn = _get_conn()
    if conn is None:
        return _no_library_feed()
    try:
        total = conn.execute("SELECT COUNT(*) FROM books").fetchone()[0]
    finally:
        conn.close()

    entries = "".join([
        _nav_entry("Tất cả sách", "urn:opds:books", "/opds/books", f"{total} cuốn sách trong thư viện"),
        _nav_entry("Mới thêm gần đây", "urn:opds:recent", "/opds/recent", "50 sách thêm vào gần đây nhất"),
        _nav_entry("Theo tác giả", "urn:opds:authors", "/opds/authors"),
        _nav_entry("Theo bộ sách", "urn:opds:series", "/opds/series"),
        _nav_entry("Theo thể loại", "urn:opds:tags", "/opds/tags"),
    ])
    # entry acquisition trực tiếp trỏ /opds/books thật ra nên type=NAV vì đây là
    # entry điều hướng (subsection), còn feed /opds/books mới là acquisition.
    return _feed("Sách Nói EPUB — Thư viện Calibre", "urn:opds:root", entries, "/opds/", NAV_TYPE)


@opds_bp.get("/books")
def opds_books():
    conn = _get_conn()
    if conn is None:
        return _no_library_feed()
    try:
        offset = max(0, request.args.get("offset", 0, type=int))
        rows, has_more = _query_books(conn, offset=offset)
        entries = "".join(_entry_xml(conn, r) for r in rows)
    finally:
        conn.close()
    paging = _paging_links("/opds/books", offset, has_more)
    return _feed("Tất cả sách", "urn:opds:books", entries, f"/opds/books?offset={offset}", ACQ_TYPE, paging)


@opds_bp.get("/recent")
def opds_recent():
    conn = _get_conn()
    if conn is None:
        return _no_library_feed()
    try:
        offset = max(0, request.args.get("offset", 0, type=int))
        rows, has_more = _query_books(
            conn, order="b.timestamp DESC", offset=offset, limit=PAGE_SIZE
        )
        entries = "".join(_entry_xml(conn, r) for r in rows)
    finally:
        conn.close()
    paging = _paging_links("/opds/recent", offset, has_more)
    return _feed("Mới thêm gần đây", "urn:opds:recent", entries, f"/opds/recent?offset={offset}", ACQ_TYPE, paging)


@opds_bp.get("/authors")
def opds_authors():
    conn = _get_conn()
    if conn is None:
        return _no_library_feed()
    try:
        rows = conn.execute("""
            SELECT a.id, a.name, COUNT(DISTINCT bal.book) as cnt
            FROM authors a
            LEFT JOIN books_authors_link bal ON bal.author = a.id
            GROUP BY a.id
            ORDER BY a.sort COLLATE NOCASE ASC
        """).fetchall()
        entries = "".join(
            _nav_entry(r["name"] or "?", f"urn:opds:author:{r['id']}", f"/opds/authors/{r['id']}", f"{r['cnt']} cuốn")
            for r in rows
        )
    finally:
        conn.close()
    return _feed("Theo tác giả", "urn:opds:authors", entries, "/opds/authors", NAV_TYPE)


@opds_bp.get("/authors/<int:author_id>")
def opds_author_books(author_id):
    conn = _get_conn()
    if conn is None:
        return _no_library_feed()
    try:
        name_row = conn.execute("SELECT name FROM authors WHERE id=?", (author_id,)).fetchone()
        title = f"Tác giả: {name_row['name']}" if name_row else "Tác giả"
        offset = max(0, request.args.get("offset", 0, type=int))
        rows, has_more = _query_books(
            conn,
            where="WHERE EXISTS (SELECT 1 FROM books_authors_link x WHERE x.book=b.id AND x.author=?)",
            params=(author_id,),
            offset=offset,
        )
        entries = "".join(_entry_xml(conn, r) for r in rows)
    finally:
        conn.close()
    paging = _paging_links(f"/opds/authors/{author_id}", offset, has_more)
    return _feed(title, f"urn:opds:author:{author_id}", entries, f"/opds/authors/{author_id}?offset={offset}", ACQ_TYPE, paging)


@opds_bp.get("/series")
def opds_series():
    conn = _get_conn()
    if conn is None:
        return _no_library_feed()
    try:
        rows = conn.execute("""
            SELECT s.id, s.name, COUNT(DISTINCT bsl.book) as cnt
            FROM series s
            LEFT JOIN books_series_link bsl ON bsl.series = s.id
            GROUP BY s.id
            ORDER BY s.name COLLATE NOCASE ASC
        """).fetchall()
        entries = "".join(
            _nav_entry(r["name"] or "?", f"urn:opds:series:{r['id']}", f"/opds/series/{r['id']}", f"{r['cnt']} cuốn")
            for r in rows
        )
    finally:
        conn.close()
    return _feed("Theo bộ sách", "urn:opds:series", entries, "/opds/series", NAV_TYPE)


@opds_bp.get("/series/<int:series_id>")
def opds_series_books(series_id):
    conn = _get_conn()
    if conn is None:
        return _no_library_feed()
    try:
        name_row = conn.execute("SELECT name FROM series WHERE id=?", (series_id,)).fetchone()
        title = f"Bộ sách: {name_row['name']}" if name_row else "Bộ sách"
        offset = max(0, request.args.get("offset", 0, type=int))
        rows, has_more = _query_books(
            conn,
            where="WHERE EXISTS (SELECT 1 FROM books_series_link x WHERE x.book=b.id AND x.series=?)",
            params=(series_id,),
            order="b.series_index ASC, b.title COLLATE NOCASE ASC",
            offset=offset,
        )
        entries = "".join(_entry_xml(conn, r) for r in rows)
    finally:
        conn.close()
    paging = _paging_links(f"/opds/series/{series_id}", offset, has_more)
    return _feed(title, f"urn:opds:series:{series_id}", entries, f"/opds/series/{series_id}?offset={offset}", ACQ_TYPE, paging)


@opds_bp.get("/tags")
def opds_tags():
    conn = _get_conn()
    if conn is None:
        return _no_library_feed()
    try:
        rows = conn.execute("""
            SELECT t.id, t.name, COUNT(DISTINCT btl.book) as cnt
            FROM tags t
            LEFT JOIN books_tags_link btl ON btl.tag = t.id
            GROUP BY t.id
            ORDER BY t.name COLLATE NOCASE ASC
        """).fetchall()
        entries = "".join(
            _nav_entry(r["name"] or "?", f"urn:opds:tag:{r['id']}", f"/opds/tags/{r['id']}", f"{r['cnt']} cuốn")
            for r in rows
        )
    finally:
        conn.close()
    return _feed("Theo thể loại", "urn:opds:tags", entries, "/opds/tags", NAV_TYPE)


@opds_bp.get("/tags/<int:tag_id>")
def opds_tag_books(tag_id):
    conn = _get_conn()
    if conn is None:
        return _no_library_feed()
    try:
        name_row = conn.execute("SELECT name FROM tags WHERE id=?", (tag_id,)).fetchone()
        title = f"Thể loại: {name_row['name']}" if name_row else "Thể loại"
        offset = max(0, request.args.get("offset", 0, type=int))
        rows, has_more = _query_books(
            conn,
            where="WHERE EXISTS (SELECT 1 FROM books_tags_link x WHERE x.book=b.id AND x.tag=?)",
            params=(tag_id,),
            offset=offset,
        )
        entries = "".join(_entry_xml(conn, r) for r in rows)
    finally:
        conn.close()
    paging = _paging_links(f"/opds/tags/{tag_id}", offset, has_more)
    return _feed(title, f"urn:opds:tag:{tag_id}", entries, f"/opds/tags/{tag_id}?offset={offset}", ACQ_TYPE, paging)


@opds_bp.get("/search")
def opds_search():
    conn = _get_conn()
    if conn is None:
        return _no_library_feed()
    q = (request.args.get("q") or "").strip()
    try:
        offset = max(0, request.args.get("offset", 0, type=int))
        if not q:
            entries = ""
            has_more = False
        else:
            like = f"%{q}%"
            rows, has_more = _query_books(
                conn,
                where="""WHERE b.title LIKE ? OR EXISTS (
                    SELECT 1 FROM books_authors_link x JOIN authors aa ON aa.id = x.author
                    WHERE x.book = b.id AND aa.name LIKE ?
                )""",
                params=(like, like),
                offset=offset,
            )
            entries = "".join(_entry_xml(conn, r) for r in rows)
    finally:
        conn.close()
    from urllib.parse import quote as _q
    qs = f"q={_q(q)}"
    paging = _paging_links("/opds/search", offset, has_more, extra_qs=qs)
    return _feed(
        f'Kết quả tìm kiếm: "{q}"' if q else "Tìm kiếm",
        "urn:opds:search",
        entries,
        f"/opds/search?{qs}&offset={offset}",
        ACQ_TYPE,
        paging,
    )


@opds_bp.get("/opensearch.xml")
def opds_opensearch():
    xml = (
        XML_HEADER
        + '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">'
        + "<ShortName>Sách Nói EPUB</ShortName>"
        + "<Description>Tìm sách trong thư viện Calibre</Description>"
        + "<InputEncoding>UTF-8</InputEncoding>"
        + "<OutputEncoding>UTF-8</OutputEncoding>"
        + f'<Url type="{xesc(ACQ_TYPE)}" template="{xesc(_abs("/opds/search"))}?q={{searchTerms}}"/>'
        + "</OpenSearchDescription>"
    )
    return Response(xml, mimetype="application/opensearchdescription+xml; charset=utf-8")
