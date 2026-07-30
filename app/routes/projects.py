"""Projects router migrated to async PostgreSQL."""

import base64
from typing import Any
from collections import defaultdict

from fastapi import APIRouter, Header, Request, Response
import msgspec
import asyncpg

from app.db import get_db
from app.structs import ClusterPost
from app.leases import clear_expired_leases, get_client_ip
from app.blacklist import E621BlacklistEvaluator, get_cluster_union_tags_and_rating

DEFAULT_BLACKLIST = """
# Violence
gore
snuff
rape

# ABDL
young -rating:s
diaper -rating:s

# Fetish
feces
urine
fart_fetish
realistic_feral rating:e

# Controversial
politics
"""

router = APIRouter()


@router.get("/api/v1/projects")
async def get_projects() -> dict[str, list[dict[str, Any]]]:
    pool = get_db()
    async with pool.acquire() as conn:
        conn: asyncpg.Connection
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


class Cluster(msgspec.Struct, kw_only=True):
    cluster_id: int
    cluster_index: int
    note: str | None = None
    is_resolved: bool
    manual_resolution: bool
    is_blacklisted: bool
    matched_rule: str | None = None
    canonical_rating: str
    posts: list[ClusterPost]


class Batch(msgspec.Struct, kw_only=True):
    batch_id: int
    project_id: str
    batch_number: int
    status: str
    leased_until: str | None = None
    is_leased_by_you: bool
    resolved_count: int
    total_clusters: int
    clusters: list[Cluster]


class ProjectBatchesResponse(msgspec.Struct, kw_only=True):
    project_id: str
    batches: list[Batch]


def parse_cluster_post(row: asyncpg.Record) -> ClusterPost:
    return ClusterPost(
        post_id=row["post_id"],
        cluster_id=row["cluster_id"],
        rating=row["rating"] or "s",
        pool_ids=row["pool_ids"] or [],
        tags_categorized=row["tags_json"] if isinstance(row["tags_json"], dict) else msgspec.json.decode(row["tags_json"] or "{}", type=dict[str, list[str]]),
        is_flagged=bool(row["is_flagged"]),
        is_deleted=bool(row["is_deleted"]),
    )


@router.get("/api/v1/projects/{project_id}/batches")
async def get_project_batches(
    project_id: str,
    request: Request,
    x_blacklist: str | None = Header(default=None),
) -> Response:
    await clear_expired_leases()
    client_ip = get_client_ip(request)

    active_blacklist_text = DEFAULT_BLACKLIST
    if x_blacklist:
        try:
            active_blacklist_text = base64.b64decode(x_blacklist).decode("utf-8")
        except Exception:
            pass

    evaluator = E621BlacklistEvaluator(active_blacklist_text)

    pool = get_db()
    async with pool.acquire() as conn:
        conn: asyncpg.Connection
        
        # 1. Single query for all batches in project
        batches_rows = await conn.fetch(
            """
            SELECT 
                b.*,
                l.ip_address AS leased_by_ip,
                l.expires_at AS leased_until
            FROM batches b
            LEFT JOIN leases l ON b.batch_id = l.batch_id
            WHERE b.project_id = $1 
            ORDER BY b.batch_number ASC
            """,
            project_id,
        )

        if not batches_rows:
            return Response(
                content=msgspec.json.encode(
                    ProjectBatchesResponse(project_id=project_id, batches=[])
                ),
                media_type="application/json",
            )

        # 2. Single query for ALL clusters and ALL posts across the entire project
        flat_rows = await conn.fetch(
            """
            SELECT c.batch_id, c.cluster_id, c.cluster_index, c.note, c.is_resolved, 
                c.manual_resolution, cp.post_id, cp.parent_id, cp.pool_ids, 
                cp.rating, cp.tags_json, 
                COALESCE(fc.active_deletion_count > 0, FALSE) AS is_deleted, 
                COALESCE(fc.active_flag_count > 0, FALSE) AS is_flagged
            FROM clusters c
            JOIN batches b ON c.batch_id = b.batch_id
            LEFT JOIN cluster_posts cp ON c.cluster_id = cp.cluster_id
            LEFT JOIN immv_post_flag_counts fc ON cp.post_id = fc.post_id
            WHERE b.project_id = $1
            ORDER BY c.batch_id ASC, c.cluster_index ASC
            """,
            project_id,
        )

    # 3. Group posts by cluster_id, and clusters by batch_id in memory
    clusters_by_batch: dict[int, dict[int, dict[str, Any]]] = defaultdict(
        lambda: defaultdict(lambda: {"info": None, "posts": []})
    )

    for row in flat_rows:
        b_id = row["batch_id"]
        c_id = row["cluster_id"]
        c_entry = clusters_by_batch[b_id][c_id]

        if c_entry["info"] is None:
            c_entry["info"] = row

        if row["post_id"] is not None:
            c_entry["posts"].append(parse_cluster_post(row))

    # 4. Construct final response objects
    batch_list: list[Batch] = []

    for b_row in batches_rows:
        b_id = b_row["batch_id"]
        raw_clusters = clusters_by_batch.get(b_id, {})

        cluster_list: list[Cluster] = []
        resolved_count = 0

        for c_id, c_data in raw_clusters.items():
            c_info = c_data["info"]
            posts = c_data["posts"]

            union_tags, canonical_rating = get_cluster_union_tags_and_rating(posts)
            is_blacklisted, matched_rule = evaluator.evaluate(
                union_tags, canonical_rating
            )

            is_res = bool(c_info["is_resolved"])
            if is_res:
                resolved_count += 1

            cluster_list.append(
                Cluster(
                    cluster_id=c_info["cluster_id"],
                    cluster_index=c_info["cluster_index"],
                    note=c_info["note"],
                    is_resolved=is_res,
                    manual_resolution=bool(c_info["manual_resolution"]),
                    is_blacklisted=is_blacklisted,
                    matched_rule=matched_rule,
                    canonical_rating=canonical_rating,
                    posts=posts,
                )
            )

        leased_until_str = b_row["leased_until"].isoformat() if b_row["leased_until"] else None

        batch_list.append(
            Batch(
                batch_id=b_id,
                project_id=b_row["project_id"],
                batch_number=b_row["batch_number"],
                leased_until=leased_until_str,
                is_leased_by_you=b_row["leased_by_ip"] == client_ip,
                status=b_row["status"],
                resolved_count=resolved_count,
                total_clusters=len(cluster_list),
                clusters=cluster_list,
            )
        )

    response_payload = ProjectBatchesResponse(
        project_id=project_id, batches=batch_list
    )
    return Response(
        content=msgspec.json.encode(response_payload),
        media_type="application/json",
    )