"""Background worker for polling e621 post edits (versions) with activity-gated safeguard."""

import asyncio
from datetime import datetime, timezone
import logging
import asyncpg
import httpx
import msgspec

from app.db import get_db
from app.config import settings
from app.rate_limiter import e621_limiter
from app.structs import E621PostVersionItem, extract_project_name_from_reason

logger = logging.getLogger("EditWorker")

USER_AGENT = f"cleanup-coordinator_edit-worker/1.2 (by {settings.e621_username})"
BASE_URL = "https://e621.net/post_versions.json"
CHUNK_LIMIT = 320
POLL_INTERVAL_SECONDS = 60.0

post_versions_decoder = msgspec.json.Decoder(type=list[E621PostVersionItem])

# Activity flag: Worker only queries e621 if client-side edits were submitted since last tick
_has_pending_activity: bool = False


def notify_edit_activity() -> None:
    """Signals that an edit was submitted from the client, scheduling a poll on the next tick."""
    global _has_pending_activity
    _has_pending_activity = True
    logger.info("[EditWorker] Edit activity received; poller will query on next cycle.")


def parse_updated_at(raw: str | None) -> datetime:
    """Safely parses ISO timestamp string into timezone-aware datetime."""
    if not raw:
        return datetime.now(timezone.utc)
    try:
        return datetime.fromisoformat(raw)
    except Exception:
        return datetime.now(timezone.utc)


async def get_known_max_edit_id(conn: asyncpg.Connection | asyncpg.pool.PoolConnectionProxy) -> int:
    """Fetches the maximum edit/version ID currently stored in post_edits."""
    max_id = await conn.fetchval("SELECT COALESCE(MAX(edit_id), 0) FROM post_edits;")
    return int(max_id or 0)


async def fetch_all_new_edits(client: httpx.AsyncClient) -> None:
    """Executes a poll cycle fetching post edits until reaching known DB state."""
    pool = get_db()
    async with pool.acquire() as conn:
        max_known_id = await get_known_max_edit_id(conn)

    current_before_id: int | None = None
    total_ingested = 0

    while True:
        await e621_limiter.wait_async()

        params: dict[str, int | str] = {
            "search[reason]": "P.A.C.K.",
            "limit": CHUNK_LIMIT,
        }
        if current_before_id:
            params["page"] = f"b{current_before_id}"

        try:
            response = await client.get(BASE_URL, params=params)

            if response.status_code == 429:
                logger.warning("[EditWorker] Hit 429 rate limit! Pausing poll cycle.")
                break

            response.raise_for_status()
            batch = post_versions_decoder.decode(response.content)

            if not batch:
                break

            edit_ids: list[int] = []
            post_ids: list[int] = []
            reasons: list[str | None] = []
            project_names: list[str | None] = []
            updated_ats: list[datetime] = []

            hit_known_threshold = False

            for item in batch:
                if item.id <= max_known_id:
                    hit_known_threshold = True

                edit_ids.append(item.id)
                post_ids.append(item.post_id)
                reasons.append(item.reason)
                project_names.append(extract_project_name_from_reason(item.reason))
                updated_ats.append(parse_updated_at(item.updated_at))

            if edit_ids:
                async with pool.acquire() as conn:
                    await conn.execute(
                        """
                        INSERT INTO post_edits (edit_id, post_id, reason, project_name, updated_at)
                        SELECT * FROM UNNEST(
                            $1::bigint[],
                            $2::bigint[],
                            $3::text[],
                            $4::text[],
                            $5::timestamptz[]
                        )
                        ON CONFLICT (edit_id) DO UPDATE SET
                            post_id = EXCLUDED.post_id,
                            reason = EXCLUDED.reason,
                            project_name = EXCLUDED.project_name,
                            updated_at = EXCLUDED.updated_at;
                        """,
                        edit_ids,
                        post_ids,
                        reasons,
                        project_names,
                        updated_ats,
                    )
                total_ingested += len(edit_ids)

            if hit_known_threshold:
                break

            current_before_id = batch[-1].id

        except Exception as e:
            logger.error(f"[EditWorker] Error during poll cycle: {type(e).__name__}: {e}", exc_info=True)
            break

    if total_ingested > 0:
        logger.info(f"[EditWorker] Successfully ingested {total_ingested} post edit(s) into database.")


async def edit_poller_loop() -> None:
    """Background worker loop polling e621 post versions at most once a minute, gated by activity."""
    global _has_pending_activity
    logger.info("[EditWorker] Starting e621 post edit verification background worker...")

    async with httpx.AsyncClient(
        headers={"User-Agent": USER_AGENT}, timeout=30.0
    ) as client:
        while True:
            try:
                if _has_pending_activity:
                    _has_pending_activity = False
                    await fetch_all_new_edits(client)
            except asyncio.CancelledError:
                logger.info("[EditWorker] Background worker stopping...")
                break
            except Exception as e:
                logger.error(f"[EditWorker] Unexpected error: {type(e).__name__}: {e}", exc_info=True)

            await asyncio.sleep(POLL_INTERVAL_SECONDS)
