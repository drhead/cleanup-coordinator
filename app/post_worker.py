import json
from pathlib import Path
import msgspec

import httpx
from typing import Any
from app.rate_limiter import e621_limiter
from app.db import get_db
from app.schemas import PostData
from app.flag_worker import fetch_and_sync_post_flags

secrets_data = json.loads(Path("secrets.json").read_text(encoding="utf-8"))
USER_AGENT = f"cleanup-coordinator_posts-worker/1.2 (by {secrets_data['e621_username']})"

POSTS_URL = "https://e621.net/posts.json"
CHUNK_LIMIT = 320

post_decoder = msgspec.json.Decoder(type=list[PostData])

async def fetch_and_update_posts_metadata_bulk(
    post_ids: list[int], client: httpx.AsyncClient | None = None
) -> list[dict[str, Any]]:
    """Fetches canonical post metadata from e621 in 320-item chunks and updates cluster_posts in bulk."""
    if not post_ids:
        return []

    should_close_client = False
    if client is None:
        client = httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, timeout=30.0)
        should_close_client = True

    updated_posts: list[dict[str, Any]] = []

    try:
        for i in range(0, len(post_ids), CHUNK_LIMIT):
            chunk = post_ids[i : i + CHUNK_LIMIT]
            id_filter = f"status:any id:{','.join(map(str, chunk))}"

            await e621_limiter.wait_async()

            response = await client.get(
                POSTS_URL,
                params={"tags": id_filter, "limit": len(chunk)},
            )

            if response.status_code == 429:
                print("[MetadataFetch] Hit 429 rate limit during bulk fetch!")
                break

            response.raise_for_status()
            posts = post_decoder.decode(response.content)

            chunk_post_ids = [post.id for post in posts]
            local_states: dict[int, tuple[bool, bool]] = {}

            if chunk_post_ids:
                placeholders = ",".join("?" * len(chunk_post_ids))
                with get_db() as conn:
                    rows = conn.execute(
                        f"SELECT post_id, is_flagged, is_deleted FROM cluster_posts WHERE post_id IN ({placeholders});",
                        chunk_post_ids,
                    ).fetchall()
                    local_states = {r[0]: (bool(r[1]), bool(r[2])) for r in rows}

            records_to_update: list[tuple[int | None, str, str, str, int]] = []

            for post in posts:
                if post.id in local_states:
                    local_flagged, local_deleted = local_states[post.id]
                    if (
                        local_flagged != post.flags.flagged
                        or local_deleted != post.flags.deleted
                    ):
                        await fetch_and_sync_post_flags(post.id, client)

                tags_by_category: dict[str, list[str]] = {}
                for category_name, tag_list in post.tags.items():
                    if tag_list:
                        tags_by_category[category_name.upper()] = sorted(tag_list)

                tags_json_str = msgspec.json.encode(tags_by_category).decode("utf-8")
                pool_ids_str = msgspec.json.encode(post.pools).decode("utf-8")
                parent_id = post.relationships.parent_id
                rating = post.rating

                records_to_update.append(
                    (parent_id, pool_ids_str, rating, tags_json_str, post.id)
                )

                updated_posts.append(
                    {
                        "post_id": post.id,
                        "parent_id": parent_id,
                        "pool_ids": post.pools,
                        "rating": rating,
                        "tags_json": tags_by_category,
                    }
                )

            if records_to_update:
                with get_db() as conn:
                    conn.execute("BEGIN TRANSACTION;")
                    conn.executemany(
                        """
                        UPDATE cluster_posts
                        SET parent_id = ?,
                            pool_ids = ?,
                            rating = ?,
                            tags_json = ?
                        WHERE post_id = ?;
                        """,
                        records_to_update,
                    )
                    conn.commit()

    except Exception as e:
        print(f"[MetadataFetch] Error during bulk fetch: {e}")
    finally:
        if should_close_client:
            await client.aclose()

    return updated_posts

async def refresh_batch_posts_background(batch_id: int) -> None:
    """Fetches fresh metadata for all posts in a batch and resets status."""
    try:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT DISTINCT post_id FROM cluster_posts WHERE cluster_id IN "
                "(SELECT cluster_id FROM clusters WHERE batch_id = ?);",
                (batch_id,),
            ).fetchall()
            post_ids = [r[0] for r in rows]

        await fetch_and_update_posts_metadata_bulk(post_ids)

    except Exception as e:
        print(f"[BatchRefresh] Error refreshing batch #{batch_id}: {e}")

def is_cluster_parentage_resolved(posts: list[dict[str, Any]]) -> bool:
    """Checks whether cluster posts share a unified parentage relationship."""
    if len(posts) < 2:
        return False

    parents = [p["parent_id"] for p in posts]
    first_parent = parents[0]
    if first_parent is not None and all(p_id == first_parent for p_id in parents):
        return True

    for root_post in posts:
        root_id = root_post["post_id"]
        children_count = sum(
            1 for p in posts if p["post_id"] != root_id and p["parent_id"] == root_id
        )
        if children_count == len(posts) - 1:
            return True

    return False


def is_cluster_pool_resolved(posts: list[dict[str, Any]]) -> bool:
    """Returns True if all posts in a cluster share at least one common pool ID."""
    if not posts:
        return False
    if len(posts) == 1:
        return True

    shared_pools = set(posts[0].get("pool_ids") or [])
    for post in posts[1:]:
        shared_pools &= set(post.get("pool_ids") or [])

    return len(shared_pools) > 0