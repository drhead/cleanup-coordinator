"""Background worker for polling e621 post flag and deletion statuses."""

import asyncio
import msgspec
import httpx
import asyncpg

from app.db import get_db
from app.secrets import secrets
from app.rate_limiter import e621_limiter
from app.structs import E621PostFlagItem

USER_AGENT = f"cleanup-coordinator_flag-worker/1.2 (by {secrets.e621_username})"

BASE_URL = "https://e621.net/post_flags.json"
CHUNK_LIMIT = 320

flag_decoder = msgspec.json.Decoder(type=list[E621PostFlagItem])


async def get_known_flag_ids(conn: asyncpg.Connection) -> int:
    """Fetches the maximum flag ID currently stored in the PostgreSQL DB."""
    max_id = await conn.fetchval("SELECT COALESCE(MAX(flag_id), 0) FROM post_flags;")
    return max_id or 0


async def refresh_post_flags(
    post_id: int, client: httpx.AsyncClient
) -> None:
    """Queries e621 for a post's flags and upserts them into the database."""
    await e621_limiter.wait_async()

    response = await client.get(BASE_URL, params={"search[post_id]": post_id})
    if response.status_code != 200:
        return

    flag_items = flag_decoder.decode(response.content)
    if not flag_items:
        return

    flag_ids = [item.id for item in flag_items]
    post_ids = [item.post_id for item in flag_items]
    is_resolved = [item.is_resolved for item in flag_items]
    is_deletion = [item.is_deletion for item in flag_items]

    pool = get_db()
    async with pool.acquire() as conn:
        conn: asyncpg.Connection
        await conn.execute(
            """
            INSERT INTO post_flags (flag_id, post_id, is_resolved, is_deletion)
            SELECT * FROM UNNEST($1::int[], $2::int[], $3::bool[], $4::bool[])
            ON CONFLICT (flag_id) DO UPDATE SET
                post_id = EXCLUDED.post_id,
                is_resolved = EXCLUDED.is_resolved,
                is_deletion = EXCLUDED.is_deletion;
            """,
            flag_ids,
            post_ids,
            is_resolved,
            is_deletion,
        )


async def fetch_all_new_flags(client: httpx.AsyncClient) -> None:
    """Executes a poll cycle fetching flags until reaching known DB state."""
    pool = get_db()
    async with pool.acquire() as conn:
        conn: asyncpg.Connection
        max_known_id = await get_known_flag_ids(conn)

    current_before_id: int | None = None

    while True:
        await e621_limiter.wait_async()

        params: dict[str, int | str] = {"limit": CHUNK_LIMIT}
        if current_before_id:
            params["page"] = f"b{current_before_id}"

        try:
            response = await client.get(BASE_URL, params=params)

            if response.status_code == 429:
                print("[FlagWorker] Hit 429 rate limit! Pausing poll cycle.")
                break

            response.raise_for_status()
            batch = flag_decoder.decode(response.content)

            if not batch:
                break

            flag_ids: list[int] = []
            post_ids: list[int] = []
            is_resolved: list[bool] = []
            is_deletion: list[bool] = []

            hit_known_threshold = False

            for flag in batch:
                if flag.id <= max_known_id:
                    hit_known_threshold = True
                    # If flag state can change (e.g., is_resolved), still include it,
                    # but stop pagination after this batch.

                flag_ids.append(flag.id)
                post_ids.append(flag.post_id)
                is_resolved.append(flag.is_resolved)
                is_deletion.append(flag.is_deletion)

            if flag_ids:
                async with pool.acquire() as conn:
                    conn: asyncpg.Connection
                    await conn.execute(
                        """
                        INSERT INTO post_flags (flag_id, post_id, is_resolved, is_deletion)
                        SELECT * FROM UNNEST($1::int[], $2::int[], $3::bool[], $4::bool[])
                        ON CONFLICT (flag_id) DO UPDATE SET
                            post_id = EXCLUDED.post_id,
                            is_resolved = EXCLUDED.is_resolved,
                            is_deletion = EXCLUDED.is_deletion;
                        """,
                        flag_ids,
                        post_ids,
                        is_resolved,
                        is_deletion,
                    )

            if hit_known_threshold:
                break

            current_before_id = batch[-1].id

        except Exception as e:
            print(f"[FlagWorker] Error during poll cycle: {e}")
            break


async def flag_poller_loop() -> None:
    """Infinite background loop running every 30 seconds."""
    print("[FlagWorker] Starting e621 flag polling background worker...")

    async with httpx.AsyncClient(
        headers={"User-Agent": USER_AGENT}, timeout=30.0
    ) as client:
        while True:
            try:
                await fetch_all_new_flags(client)
            except asyncio.CancelledError:
                print("[FlagWorker] Background worker stopping...")
                break
            except Exception as e:
                print(f"[FlagWorker] Unexpected error: {e}")

            await asyncio.sleep(30)