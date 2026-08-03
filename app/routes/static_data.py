"""Router for serving static MessagePack data compressed in-memory."""

from functools import lru_cache
import gzip
from pathlib import Path

from fastapi import APIRouter, Request, Response
import brotli

router = APIRouter()

BASE_DATA_PATH = Path("./static/data/tag_implications.msgpack")

@lru_cache(maxsize=1)
def get_raw_bytes() -> bytes:
    return BASE_DATA_PATH.read_bytes()


@lru_cache(maxsize=1)
def get_gz_bytes() -> bytes:
    return gzip.compress(get_raw_bytes(), compresslevel=9)


@lru_cache(maxsize=1)
def get_br_bytes() -> bytes:
    return brotli.compress(get_raw_bytes())


def parse_accept_encoding(header: str) -> set[str]:
    """Parse Accept-Encoding header into a clean set of supported encodings."""
    encodings: set[str] = set()
    for segment in header.split(","):
        token = segment.split(";")[0].strip().lower()
        if token:
            encodings.add(token)
    return encodings


@router.get("/static/data/tag_implications.msgpack")
async def get_tag_implications(request: Request) -> Response:
    raw_header = request.headers.get("accept-encoding", "")
    encodings = parse_accept_encoding(raw_header)
    media_type = "application/msgpack"

    if "br" in encodings:
        return Response(
            content=get_br_bytes(),
            media_type=media_type,
            headers={"Content-Encoding": "br", "Vary": "Accept-Encoding"},
        )

    if "gzip" in encodings:
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