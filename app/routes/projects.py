import base64
from typing import Any
import sqlite3

from fastapi import APIRouter, Header, Request, Response
import msgspec

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

POOL_DECODER = msgspec.json.Decoder(type=list[int]).decode
TAGS_DECODER = msgspec.json.Decoder(type=dict[str, list[str]]).decode

router = APIRouter()

@router.get("/api/v1/projects")
def get_projects() -> dict[str, list[dict[str, Any]]]:
    with get_db() as conn:
        projects = conn.execute(
            """
            SELECT 
                p.*,
                COUNT(c.cluster_id) AS total_clusters,
                SUM(CASE WHEN c.is_resolved = 1 THEN 1 ELSE 0 END) AS resolved_clusters
            FROM projects p
            LEFT JOIN batches b ON p.project_id = b.project_id
            LEFT JOIN clusters c ON b.batch_id = c.batch_id
            GROUP BY p.project_id;
            """
        ).fetchall()
        return {"projects": [dict(p) for p in projects]}

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

def parse_cluster_post(row: sqlite3.Row) -> ClusterPost:
    return ClusterPost(
        post_id=row["post_id"],
        cluster_id=row["cluster_id"],
        rating=row["rating"] or "s",
        pool_ids=POOL_DECODER(row["pool_ids"] or "[]"),
        tags_categorized=TAGS_DECODER(row["tags_json"] or "{}"),
        is_flagged=bool(row["calculated_flagged"]),
        is_deleted=bool(row["calculated_deleted"]),
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

    with get_db() as conn:
        batches_rows = conn.execute(
            """
            SELECT 
                b.*,
                l.ip_address AS leased_by_ip,
                l.expires_at AS leased_until
            FROM batches b
            LEFT JOIN leases l ON b.batch_id = l.batch_id
            WHERE b.project_id = ? 
            ORDER BY b.batch_number ASC
            """,
            (project_id,),
        ).fetchall()

        batch_list: list[Batch] = []

        for b_row in batches_rows:
            cluster_rows = conn.execute(
                "SELECT * FROM clusters WHERE batch_id = ? ORDER BY cluster_index ASC",
                (b_row["batch_id"],),
            ).fetchall()

            cluster_list: list[Cluster] = []
            resolved_count = 0

            for c_row in cluster_rows:
                post_rows = conn.execute(
                    """
                    SELECT 
                        cp.*,
                        EXISTS (
                            SELECT 1 FROM post_flags pf 
                            WHERE pf.post_id = cp.post_id 
                              AND pf.is_resolved = FALSE 
                              AND pf.is_deletion = TRUE
                        ) AS calculated_deleted,
                        EXISTS (
                            SELECT 1 FROM post_flags pf 
                            WHERE pf.post_id = cp.post_id 
                              AND pf.is_resolved = FALSE 
                              AND pf.is_deletion = FALSE
                        ) AS calculated_flagged
                    FROM cluster_posts cp
                    WHERE cp.cluster_id = ?
                    """,
                    (c_row["cluster_id"],),
                ).fetchall()

                posts = [parse_cluster_post(p) for p in post_rows]

                union_tags, canonical_rating = get_cluster_union_tags_and_rating(posts)
                is_blacklisted, matched_rule = evaluator.evaluate(
                    union_tags, canonical_rating
                )

                is_res = bool(c_row["is_resolved"])
                if is_res:
                    resolved_count += 1

                cluster_list.append(
                    Cluster(
                        cluster_id=c_row["cluster_id"],
                        cluster_index=c_row["cluster_index"],
                        note=c_row["note"],
                        is_resolved=is_res,
                        manual_resolution=bool(c_row["manual_resolution"]),
                        is_blacklisted=is_blacklisted,
                        matched_rule=matched_rule,
                        canonical_rating=canonical_rating,
                        posts=posts,
                    )
                )

            batch_list.append(
                Batch(
                    batch_id=b_row["batch_id"],
                    project_id=b_row["project_id"],
                    batch_number=b_row["batch_number"],
                    leased_until=b_row["leased_until"],
                    is_leased_by_you=b_row["leased_by_ip"] == client_ip,
                    status=b_row["status"],
                    resolved_count=resolved_count,
                    total_clusters=len(cluster_rows),
                    clusters=cluster_list,
                )
            )

    response_payload = ProjectBatchesResponse(project_id=project_id, batches=batch_list)
    return Response(
        content=msgspec.json.encode(response_payload),
        media_type="application/json",
    )