"""Router for serving static MessagePack data using pre-compressed disk assets."""

from pathlib import Path
from fastapi import APIRouter, Request, Response

router = APIRouter()

BASE_DATA_PATH = Path("./static/data/tag_implications.msgpack")
BR_DATA_PATH = Path("./static/data/tag_implications.msgpack.br")
GZ_DATA_PATH = Path("./static/data/tag_implications.msgpack.gz")

_cached_br: bytes | None = None
_cached_gz: bytes | None = None
_cached_raw: bytes | None = None


def get_br_bytes() -> bytes:
    global _cached_br
    if _cached_br is None:
        _cached_br = BR_DATA_PATH.read_bytes()
    return _cached_br


def get_gz_bytes() -> bytes:
    global _cached_gz
    if _cached_gz is None:
        _cached_gz = GZ_DATA_PATH.read_bytes()
    return _cached_gz


def get_raw_bytes() -> bytes:
    global _cached_raw
    if _cached_raw is None:
        _cached_raw = BASE_DATA_PATH.read_bytes()
    return _cached_raw


@router.get("/static/data/tag_implications.msgpack")
async def get_tag_implications(request: Request) -> Response:
    accept_encoding = request.headers.get("Accept-Encoding", "").lower()
    media_type = "application/msgpack"

    if "br" in accept_encoding:
        return Response(
            content=get_br_bytes(),
            media_type=media_type,
            headers={"Content-Encoding": "br", "Vary": "Accept-Encoding"},
        )

    if "gzip" in accept_encoding:
        return Response(
            content=get_gz_bytes(),
            media_type=media_type,
            headers={"Content-Encoding": "gzip", "Vary": "Accept-Encoding"},
        )

    return Response(
        content=get_raw_bytes(),
        media_type=media_type,
        headers={"Vary": "Accept-Encoding"},
    )