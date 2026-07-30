"""Background worker for polling e621 post flag and deletion statuses."""

import asyncio
import json
from pathlib import Path
import sqlite3

import httpx

from app.db import get_db
from app.rate_limiter import e621_limiter
from app.schemas import flag_decoder

SECRETS_PATH = Path("secrets.json")
BASE_URL = "https://e621.net/post_flags.json"
LIMIT = 320

secrets_data = json.loads(SECRETS_PATH.read_text(encoding="utf-8"))
USER_AGENT = f"postflags_worker/1.0 (by {secrets_data['e621_username']})"


def get_known_flag_ids(conn: sqlite3.Connection) -> set[int]:
    """Fetches all flag IDs currently stored in the local SQLite DB."""
    rows = conn.execute("SELECT flag_id FROM post_flags;").fetchall()
    return {r[0] for r in rows}


async def poll_e621_flags_once(client: httpx.AsyncClient) -> None:
    """Executes a poll cycle fetching flags until overlapping with known DB state."""
    with get_db() as conn:
        known_ids = get_known_flag_ids(conn)

    current_before_id: int | None = None

    while True:
        await e621_limiter.wait_async()

        params: dict[str, int | str] = {"limit": LIMIT}
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

            records_to_upsert: list[tuple[int, int, int, int]] = []
            batch_overlap = 0

            for flag in batch:
                if flag.id in known_ids:
                    batch_overlap += 1
                else:
                    known_ids.add(flag.id)

                records_to_upsert.append(
                    (
                        flag.id,
                        flag.post_id,
                        int(flag.is_resolved),
                        int(flag.is_deletion),
                    )
                )

            if records_to_upsert:
                with get_db() as conn:
                    conn.execute("BEGIN TRANSACTION;")
                    conn.executemany(
                        """
                        INSERT INTO post_flags (flag_id, post_id, is_resolved, is_deletion)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT(flag_id) DO UPDATE SET
                            post_id = excluded.post_id,
                            is_resolved = excluded.is_resolved,
                            is_deletion = excluded.is_deletion;
                        """,
                        records_to_upsert,
                    )
                    conn.commit()

            current_before_id = batch[-1].id

            if batch_overlap == len(batch):
                break

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
                await poll_e621_flags_once(client)
            except asyncio.CancelledError:
                print("[FlagWorker] Background worker stopping...")
                break
            except Exception as e:
                print(f"[FlagWorker] Unexpected error: {e}")

            await asyncio.sleep(30)