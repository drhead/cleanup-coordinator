"""Router for serving static MessagePack data with ETag and compressed caching."""

from functools import lru_cache
import gzip
from pathlib import Path
from datetime import datetime, time, timedelta, timezone
from email.utils import format_datetime

from fastapi import APIRouter, Request, Response
import brotli

router = APIRouter()

STATIC_DATA_DIR = Path("./static/data")


def get_file_stat_key(path: Path) -> tuple[str, float, int]:
    """Generate a cache key based on path, modification time, and file size."""
    if not path.exists():
        return (str(path), 0.0, 0)
    stat = path.stat()
    return (str(path.resolve()), stat.st_mtime, stat.st_size)


@lru_cache(maxsize=5)
def _read_raw_cached(path_str: str, mtime: float, size: int) -> bytes:
    return Path(path_str).read_bytes()


def get_raw_bytes(path: Path) -> bytes:
    key = get_file_stat_key(path)
    return _read_raw_cached(*key)


@lru_cache(maxsize=5)
def _read_gz_cached(path_str: str, mtime: float, size: int) -> bytes:
    gz_path = Path(f"{path_str}.gz")
    if gz_path.is_file():
        return gz_path.read_bytes()
    raw = Path(path_str).read_bytes()
    return gzip.compress(raw, compresslevel=9)


def get_gz_bytes(path: Path) -> bytes:
    key = get_file_stat_key(path)
    return _read_gz_cached(*key)


@lru_cache(maxsize=5)
def _read_br_cached(path_str: str, mtime: float, size: int) -> bytes:
    br_path = Path(f"{path_str}.br")
    if br_path.is_file():
        return br_path.read_bytes()
    raw = Path(path_str).read_bytes()
    return brotli.compress(raw, quality=11)


def get_br_bytes(path: Path) -> bytes:
    key = get_file_stat_key(path)
    return _read_br_cached(*key)


def parse_accept_encoding(header: str) -> set[str]:
    """Parse Accept-Encoding header into a clean set of supported encodings."""
    encodings: set[str] = set()
    for segment in header.split(","):
        token = segment.split(";")[0].strip().lower()
        if token:
            encodings.add(token)
    return encodings

def get_next_invalidation_target(target_hour: int = 6, target_minute: int = 15) -> datetime:
    """Returns the next 06:15 UTC target as an absolute aware datetime."""
    now = datetime.now(timezone.utc)
    target = datetime.combine(
        now.date(),
        time(target_hour, target_minute),
        tzinfo=timezone.utc,
    )

    if now >= target:
        target += timedelta(days=1)

    return target


def get_expiration_headers(target_hour: int = 6, target_minute: int = 15) -> dict[str, str]:
    target_dt = get_next_invalidation_target(target_hour, target_minute)
    now = datetime.now(timezone.utc)
    
    # Delta seconds for max-age (floor at 60s safety window)
    remaining_seconds = max(int((target_dt - now).total_seconds()), 60)
    
    # Format RFC 1123 HTTP-date string for Expires header (e.g. "Tue, 04 Aug 2026 06:15:00 GMT")
    expires_str = format_datetime(target_dt, usegmt=True)

    return {
        "Cache-Control": f"public, max-age={remaining_seconds}, stale-while-revalidate=3600",
        "Expires": expires_str,
    }

def build_etag(path: Path) -> str:
    """Construct a strong ETag based on mtime and byte size."""
    stat = path.stat()
    return f'"{hex(int(stat.st_mtime))[2:]}-{hex(stat.st_size)[2:]}"'


async def serve_static_msgpack(filename: str, request: Request) -> Response:
    file_path = STATIC_DATA_DIR / filename
    if not file_path.is_file():
        return Response(status_code=404)

    etag = build_etag(file_path)
    if_none_match = request.headers.get("if-none-match")
    
    exp_headers = get_expiration_headers(target_hour=6, target_minute=15)
    cache_headers = {
        "ETag": etag,
        "Vary": "Accept-Encoding",
        **exp_headers,
    }

    # 1. Immediate 304 if browser cache is still valid
    if if_none_match and if_none_match == etag:
        return Response(status_code=304, headers=cache_headers)

    # 2. Select content body & encoding
    raw_header = request.headers.get("accept-encoding", "")
    encodings = parse_accept_encoding(raw_header)
    media_type = "application/msgpack"

    content_encoding = None
    if "br" in encodings:
        content = get_br_bytes(file_path)
        content_encoding = "br"
    elif "gzip" in encodings:
        content = get_gz_bytes(file_path)
        content_encoding = "gzip"
    else:
        content = get_raw_bytes(file_path)

    # 3. Return response with combined headers
    response = Response(content=content, media_type=media_type)
    for key, value in cache_headers.items():
        response.headers[key] = value

    if content_encoding:
        response.headers["Content-Encoding"] = content_encoding

    return response


@router.get("/static/data/tag_implications.msgpack")
async def get_tag_implications(request: Request) -> Response:
    return await serve_static_msgpack("tag_implications.msgpack", request)


@router.get("/static/data/tags.msgpack")
async def get_tags(request: Request) -> Response:
    return await serve_static_msgpack("tags.msgpack", request)