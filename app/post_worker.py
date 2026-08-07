"""Posts worker service migrated to async PostgreSQL."""

from typing import Any
import logging
import asyncio

import httpx
import msgspec

from app.db import get_db
from app.secrets import secrets
from app.rate_limiter import e621_limiter
from app.structs import PostData
from app.flag_worker import refresh_post_flags

USER_AGENT = f"cleanup-coordinator_posts-worker/1.2 (by {secrets.e621_username})"

POSTS_URL = "https://e621.net/posts.json"
CHUNK_LIMIT = 320

logger = logging.getLogger("PostsWorker")


class PostsResponse(msgspec.Struct):
    posts: list[PostData]


post_decoder = msgspec.json.Decoder(type=PostsResponse)


async def refresh_posts_metadata(
    post_ids: list[int], client: httpx.AsyncClient | None = None
) -> list[dict[str, Any]]:
    """Fetches canonical post metadata from e621 in chunks and updates cluster_posts directly."""
    if not post_ids:
        return []

    should_close_client = False
    if client is None:
        client = httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, timeout=30.0)
        should_close_client = True

    updated_posts: list[dict[str, Any]] = []
    pool = get_db()

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
            posts = post_decoder.decode(response.content).posts

            chunk_post_ids = [post.id for post in posts]
            local_states: dict[int, tuple[bool, bool]] = {}

            if chunk_post_ids:
                async with pool.acquire() as conn:
                    rows = await conn.fetch(
                        """
                        SELECT post_id, is_flagged, is_deleted
                        FROM cluster_post_flags
                        WHERE post_id = ANY($1::bigint[]);
                        """,
                        chunk_post_ids,
                    )
                    local_states = {
                        r["post_id"]: (
                            bool(r["is_flagged"]),
                            bool(r["is_deleted"]),
                        )
                        for r in rows
                    }

            records_to_update: list[tuple[int | None, list[int], list[str], str, int]] = []

            for post in posts:
                if post.id in local_states:
                    local_flagged, local_deleted = local_states[post.id]
                    if (
                        local_flagged != post.flags.flagged
                        or local_deleted != post.flags.deleted
                    ):
                        await refresh_post_flags(post.id, client)

                flat_tags = post.flat_tags()
                parent_id = post.relationships.parent_id
                rating = post.rating
                pool_ids = post.pools

                records_to_update.append(
                    (parent_id, pool_ids, flat_tags, rating, post.id)
                )

                updated_posts.append(
                    {
                        "post_id": post.id,
                        "parent_id": parent_id,
                        "pool_ids": pool_ids,
                        "rating": rating,
                        "tags": flat_tags,
                    }
                )

            if records_to_update:
                parent_ids, pool_ids_list, tags_list, ratings, target_post_ids = zip(*records_to_update)

                # Format Python lists into PostgreSQL array string literals
                formatted_pool_ids = [f"{{{','.join(map(str, p))}}}" for p in pool_ids_list]
                formatted_tags = [f"{{{','.join(t)}}}" for t in tags_list]  # Ensure tags with special chars are quoted if needed

                async with pool.acquire() as conn:
                    await conn.execute(
                        """
                        UPDATE cluster_posts cp
                        SET parent_id = u.parent_id,
                            pool_ids = u.pool_ids::int[],
                            tags = u.tags::text[],
                            rating = u.rating
                        FROM UNNEST(
                            $1::bigint[],
                            $2::text[],
                            $3::text[],
                            $4::text[],
                            $5::bigint[]
                        ) AS u(parent_id, pool_ids, tags, rating, post_id)
                        WHERE cp.post_id = u.post_id
                        AND (
                            cp.parent_id IS DISTINCT FROM u.parent_id OR
                            cp.pool_ids IS DISTINCT FROM u.pool_ids::int[] OR
                            cp.tags IS DISTINCT FROM u.tags::text[] OR
                            cp.rating IS DISTINCT FROM u.rating
                        );
                        """,
                        list(parent_ids),
                        formatted_pool_ids,
                        formatted_tags,
                        list(ratings),
                        list(target_post_ids),
                    )

    except Exception as e:
        print(f"[MetadataFetch] Error during bulk fetch: {e}")
    finally:
        if should_close_client:
            await client.aclose()

    return updated_posts


async def refresh_batch_posts(batch_id: int) -> None:
    """Fetches fresh metadata for all posts in a batch and resets status."""
    try:
        pool = get_db()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT DISTINCT cp.post_id FROM cluster_posts cp
                JOIN clusters c ON cp.cluster_id = c.cluster_id
                WHERE c.batch_id = $1;
                """,
                batch_id,
            )
            post_ids = [r["post_id"] for r in rows]

        await refresh_posts_metadata(post_ids)

    except Exception as e:
        print(f"[BatchRefresh] Error refreshing batch #{batch_id}: {e}")


async def get_all_project_ids() -> list[str]:
    """Retrieves all distinct project IDs from the database."""
    pool = get_db()
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT DISTINCT project_id FROM batches;")
        return [r["project_id"] for r in rows if r["project_id"]]


async def get_project_post_ids(project_id: str) -> list[int]:
    """Retrieves all distinct post IDs belonging to a project."""
    query = """
        SELECT DISTINCT cp.post_id
        FROM cluster_posts cp
        JOIN clusters c ON cp.cluster_id = c.cluster_id
        JOIN batches b ON c.batch_id = b.batch_id
        WHERE b.project_id = $1;
    """
    pool = get_db()
    async with pool.acquire() as conn:
        rows = await conn.fetch(query, project_id)
        return [r["post_id"] for r in rows]


def calculate_project_interval(total_posts: int) -> int:
    """Calculates refresh interval: max(300, 30 * (total_posts // 320)) seconds."""
    return max(300, 30 * (total_posts // 320))


async def project_refresh_loop(project_id: str) -> None:
    """Independent worker loop for a single project."""
    while True:
        try:
            post_ids = await get_project_post_ids(project_id)
            total_posts = len(post_ids)
            interval = calculate_project_interval(total_posts)

            if post_ids:
                logger.info(
                    f"[ProjectWorker] Starting metadata refresh for project '{project_id}' "
                    f"({total_posts} posts, next run in {interval}s)"
                )
                await refresh_posts_metadata(post_ids)
            else:
                logger.info(
                    f"[ProjectWorker] No posts found for project '{project_id}'. "
                    f"Retrying in {interval}s"
                )

        except asyncio.CancelledError:
            logger.info(f"[ProjectWorker] Worker for project '{project_id}' stopping.")
            break
        except Exception as e:
            logger.error(f"[ProjectWorker] Error refreshing project '{project_id}': {e}")
            interval = 300  # Fallback interval on error

        await asyncio.sleep(interval)


class ProjectWorkerManager:
    """Manages independent background worker tasks per project."""

    def __init__(self) -> None:
        self._tasks: dict[str, asyncio.Task[None]] = {}

    async def sync_projects(self) -> None:
        """Spawns worker tasks for new projects found in DB."""
        active_projects = await get_all_project_ids()
        for project_id in active_projects:
            if project_id not in self._tasks or self._tasks[project_id].done():
                logger.info(f"[ProjectWorker] Spawning worker for project '{project_id}'")
                task = asyncio.create_task(
                    project_refresh_loop(project_id),
                    name=f"project_worker_{project_id}",
                )
                self._tasks[project_id] = task

    async def stop_all(self) -> None:
        """Cancels all active project worker tasks."""
        for task in self._tasks.values():
            task.cancel()

        if self._tasks:
            await asyncio.gather(*self._tasks.values(), return_exceptions=True)
            self._tasks.clear()


project_worker_manager = ProjectWorkerManager()