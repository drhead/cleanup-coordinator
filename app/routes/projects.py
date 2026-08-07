"""Projects router."""

from typing import Any
from collections import defaultdict
import gzip
import brotli

from fastapi import APIRouter, Request, Response
import msgspec
import asyncpg
import xxhash

from app.db import get_db

router = APIRouter()


@router.get("/api/v1/projects")
async def get_projects() -> dict[str, list[dict[str, Any]]]:
    pool = get_db()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT 
                p.*,
                COUNT(c.cluster_id) AS total_clusters,
                SUM(CASE WHEN c.is_resolved = TRUE THEN 1 ELSE 0 END) AS resolved_clusters
            FROM projects p
            LEFT JOIN batches b ON p.project_id = b.project_id
            LEFT JOIN clusters c ON b.batch_id = c.batch_id
            GROUP BY p.project_id;
            """
        )
        return {"projects": [dict(r) for r in rows]}


class ClusterPost(msgspec.Struct, kw_only=True):
    post_id: int
    cluster_id: int
    rating: str = "s"
    pool_ids: list[int] = msgspec.field(default_factory=list[int])
    tags: list[str] = msgspec.field(default_factory=list[str])
    is_flagged: bool = False
    is_deleted: bool = False
    image_width: int | None = None
    image_height: int | None = None
    image_format: str | None = None
    image_quality: int | None = None

class Cluster(msgspec.Struct, kw_only=True):
    cluster_id: int
    cluster_index: int
    note: str | None = None
    is_resolved: bool
    manual_resolution: bool
    posts: list[ClusterPost]


class Batch(msgspec.Struct, kw_only=True):
    batch_id: int
    project_id: str
    batch_number: int
    status: str
    resolved_count: int
    total_clusters: int
    clusters: list[Cluster]


class ProjectBatchesResponse(msgspec.Struct, kw_only=True):
    project_id: str
    batches: list[Batch]


msgpack_encoder = msgspec.msgpack.Encoder()


def parse_cluster_post(row: asyncpg.Record) -> ClusterPost:
    return ClusterPost(
        post_id=row["post_id"],
        cluster_id=row["cluster_id"],
        rating=row["rating"] or "s",
        pool_ids=row["pool_ids"] or [],
        tags=row["tags"] or [],
        is_flagged=bool(row["is_flagged"]),
        is_deleted=bool(row["is_deleted"]),
        image_width=row["image_width"],
        image_height=row["image_height"],
        image_format=row["image_format"],
        image_quality=row["image_quality"],
    )


def parse_accept_encoding(header: str) -> set[str]:
    """Parse Accept-Encoding header into a clean set of supported encodings."""
    encodings: set[str] = set()
    for segment in header.split(","):
        token = segment.split(";")[0].strip().lower()
        if token:
            encodings.add(token)
    return encodings

def compute_etag(
    batches_rows: list[asyncpg.Record], flat_rows: list[asyncpg.Record]
) -> str:
    hasher = xxhash.xxh3_64()

    for r in batches_rows:
        hasher.update(hash(tuple(r)).to_bytes(8, "little", signed=True))

    # Fixed schema where only index 8 (pool_ids) and index 10 (tags) are lists.
    for r in flat_rows:
        row_hash = hash((
            r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7],
            tuple(r[8]) if r[8] else (),
            r[9],
            tuple(r[10]) if r[10] else (),
            r[11], r[12], r[13], r[14], r[15], r[16]
        ))
        hasher.update(row_hash.to_bytes(8, "little", signed=True))

    return f'"{hasher.hexdigest()}"'

@router.get("/api/v1/projects/{project_id}/batches")
async def get_project_batches(
    project_id: str,
    request: Request
) -> Response:

    pool = get_db()
    async with pool.acquire() as conn:
        # 1. Fetch batches
        batches_rows = await conn.fetch(
            """
            SELECT 
                batch_id,
                project_id,
                batch_number,
                status
            FROM v_batches 
            WHERE project_id = $1 
            ORDER BY batch_number ASC;
            """,
            project_id,
        )

        if not batches_rows:
            raw_payload = msgpack_encoder.encode(
                ProjectBatchesResponse(project_id=project_id, batches=[])
            )
            return Response(
                content=raw_payload,
                media_type="application/msgpack",
            )

        # 2. Fetch clusters and post metadata
        flat_rows = await conn.fetch(
            """
            SELECT c.batch_id, c.cluster_id, c.cluster_index, c.note, c.is_resolved, 
                   c.manual_resolution, cp.post_id, cp.parent_id, cp.pool_ids, 
                   cp.rating, cp.tags,
                   cp.image_width, cp.image_height, cp.image_format, cp.image_quality,
                   COALESCE(fc.active_deletion_count > 0, FALSE) AS is_deleted, 
                   COALESCE(fc.active_flag_count > 0, FALSE) AS is_flagged
            FROM clusters c
            JOIN batches b ON c.batch_id = b.batch_id
            LEFT JOIN cluster_posts cp ON c.cluster_id = cp.cluster_id
            LEFT JOIN immv_post_flag_counts fc ON cp.post_id = fc.post_id
            WHERE b.project_id = $1
            ORDER BY c.batch_id ASC, c.cluster_index ASC, cp.post_id ASC
            """,
            project_id,
        )

    # since our query is quite fast and is cachable by ReadySet we can ETag this
    # and avoid sending the payload
    etag = compute_etag(batches_rows, flat_rows)

    # Check against incoming If-None-Match header
    if_none_match = request.headers.get("if-none-match") or request.headers.get("If-None-Match")
    if if_none_match:
        clean_if_none_match = if_none_match.strip().lstrip("W/")
        if clean_if_none_match == etag:
            return Response(
                status_code=304,
                headers={
                    "ETag": etag,
                    "Cache-Control": "no-cache",
                    "Vary": "Accept-Encoding",
                },
            )

    # 3. Group in memory (Only reached if database data actually changed)
    clusters_by_batch: dict[int, dict[int, dict[str, Any]]] = defaultdict(
        lambda: defaultdict(lambda: {"info": None, "posts": []})
    )

    for row in flat_rows:
        b_id = row["batch_id"]
        c_id = row["cluster_id"]
        c_entry = clusters_by_batch[b_id][c_id]

        if c_entry["info"] is None:
            c_entry["info"] = row

        pid = row["post_id"]
        if pid is not None:
            c_entry["posts"].append(parse_cluster_post(row))

    # 4. Build response structs
    batch_list: list[Batch] = []

    for b_row in batches_rows:
        b_id = b_row["batch_id"]
        raw_clusters = clusters_by_batch.get(b_id, {})

        cluster_list: list[Cluster] = []
        resolved_count = 0

        for c_id, c_data in raw_clusters.items():
            c_info = c_data["info"]
            posts = c_data["posts"]

            if c_info["is_resolved"]:
                resolved_count += 1

            cluster_list.append(
                Cluster(
                    cluster_id=c_info["cluster_id"],
                    cluster_index=c_info["cluster_index"],
                    note=c_info["note"],
                    is_resolved=c_info["is_resolved"],
                    manual_resolution=bool(c_info["manual_resolution"]),
                    posts=posts,
                )
            )

        batch_list.append(
            Batch(
                batch_id=b_id,
                project_id=b_row["project_id"],
                batch_number=b_row["batch_number"],
                status=b_row["status"],
                resolved_count=resolved_count,
                total_clusters=len(cluster_list),
                clusters=cluster_list,
            )
        )

    response_payload = ProjectBatchesResponse(
        project_id=project_id, batches=batch_list
    )
    raw_bytes = msgpack_encoder.encode(response_payload)

    # 5. Compress dynamically based on Accept-Encoding
    encodings = parse_accept_encoding(request.headers.get("accept-encoding", ""))
    media_type = "application/msgpack"
    headers = {"ETag": etag, "Vary": "Accept-Encoding"}

    if "br" in encodings:
        compressed = brotli.compress(raw_bytes, quality=3)
        headers["Content-Encoding"] = "br"
        return Response(content=compressed, media_type=media_type, headers=headers)

    if "gzip" in encodings:
        compressed = gzip.compress(raw_bytes, compresslevel=6)
        headers["Content-Encoding"] = "gzip"
        return Response(content=compressed, media_type=media_type, headers=headers)

    return Response(content=raw_bytes, media_type=media_type, headers=headers)