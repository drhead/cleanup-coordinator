import base64
from typing import Any
import json

from fastapi import APIRouter, Header, Request

from app.db import get_db
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


@router.get("/api/v1/projects/{project_id}/batches")
async def get_project_batches(
    project_id: str,
    request: Request,
    x_blacklist: str | None = Header(default=None),
) -> dict[str, Any]:
    await clear_expired_leases()
    client_ip = get_client_ip(request)

    if x_blacklist:
        try:
            active_blacklist_text = base64.b64decode(x_blacklist).decode("utf-8")
        except Exception:
            active_blacklist_text = DEFAULT_BLACKLIST
    else:
        active_blacklist_text = DEFAULT_BLACKLIST

    evaluator = E621BlacklistEvaluator(active_blacklist_text)

    with get_db() as conn:
        batches = conn.execute(
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

        result: list[dict[str, Any]] = []
        for b in batches:
            clusters = conn.execute(
                "SELECT * FROM clusters WHERE batch_id = ? ORDER BY cluster_index ASC",
                (b["batch_id"],),
            ).fetchall()

            cluster_list: list[dict[str, Any]] = []
            resolved_count = 0

            for c in clusters:
                posts = conn.execute(
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
                    (c["cluster_id"],),
                ).fetchall()

                post_list: list[dict[str, Any]] = []
                for p in posts:
                    post_dict = dict(p)
                    post_dict["pool_ids"] = json.loads(post_dict.get("pool_ids") or "[]")
                    post_dict["tags_json"] = json.loads(post_dict.get("tags_json") or "{}")
                    post_dict["is_flagged"] = bool(post_dict["calculated_flagged"])
                    post_dict["is_deleted"] = bool(post_dict["calculated_deleted"])
                    post_list.append(post_dict)

                union_tags, canonical_rating = get_cluster_union_tags_and_rating(post_list)
                is_blacklisted, matched_rule = evaluator.evaluate(
                    union_tags, canonical_rating
                )

                is_res = bool(c["is_resolved"])
                if is_res:
                    resolved_count += 1

                cluster_list.append(
                    {
                        "cluster_id": c["cluster_id"],
                        "cluster_index": c["cluster_index"],
                        "note": c["note"],
                        "is_resolved": is_res,
                        "manual_resolution": bool(c["manual_resolution"]),
                        "is_blacklisted": is_blacklisted,
                        "matched_rule": matched_rule,
                        "canonical_rating": canonical_rating,
                        "posts": post_list,
                    }
                )

            batch_dict = dict(b)
            is_my_lease = b["leased_by_ip"] == client_ip
            del batch_dict["leased_by_ip"]

            batch_dict.update(
                {
                    "is_leased_by_you": is_my_lease,
                    "resolved_count": resolved_count,
                    "total_clusters": len(clusters),
                    "clusters": cluster_list,
                }
            )
            result.append(batch_dict)

    return {"project_id": project_id, "batches": result}
