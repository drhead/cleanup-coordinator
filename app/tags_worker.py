import asyncio
import csv
import gzip
import io
import msgspec
import logging
from datetime import datetime, time, timedelta, timezone
from pathlib import Path

import httpx

from app.db import get_db

logger = logging.getLogger("tags_worker")

TAGS_EXPORT_URL = "https://static1.e621.net/data/db_export/tags.csv.gz"
IMPLICATIONS_EXPORT_URL = "https://static1.e621.net/data/db_export/tag_implications.csv.gz"

OUTPUT_IMPLICATIONS_MSGPACK = Path("static/data/tag_implications.msgpack")
OUTPUT_IMPLICATIONS_MSGPACK.parent.mkdir(parents=True, exist_ok=True)

CATEGORY_MAP = {
    "0": "general",
    "1": "artist",
    "2": "contributor",
    "3": "copyright",
    "4": "character",
    "5": "species",
    "6": "invalid",
    "7": "meta",
    "8": "lore",
}


async def sync_daily_tags_export() -> None:
    logger.info("Starting tags sync...")
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.get(TAGS_EXPORT_URL, follow_redirects=True)
            response.raise_for_status()

        logger.info("Downloaded tags export. Decompressing and parsing CSV...")
        decompressed = gzip.decompress(response.content)
        csv_reader = csv.DictReader(io.StringIO(decompressed.decode("utf-8")))

        records = [
            (
                row["name"],
                CATEGORY_MAP.get(row.get("category", "0"), "general"),
                int(row.get("post_count", 0)),
            )
            for row in csv_reader
        ]

        pool = get_db()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    CREATE TEMP TABLE staging_tags (
                        tag_name TEXT PRIMARY KEY,
                        category TEXT NOT NULL,
                        post_count BIGINT NOT NULL
                    ) ON COMMIT DROP;
                """
                )

                await conn.copy_records_to_table(
                    "staging_tags",
                    records=records,
                    columns=["tag_name", "category", "post_count"],
                )

                await conn.execute(
                    """
                    INSERT INTO tags (tag_name, category, post_count)
                    SELECT tag_name, category, post_count FROM staging_tags
                    ON CONFLICT (tag_name) DO UPDATE SET
                        category = EXCLUDED.category,
                        post_count = EXCLUDED.post_count;
                """
                )

        logger.info(f"Successfully synced {len(records)} tags.")
    except Exception as e:
        logger.error(f"Failed to sync tags: {e}", exc_info=True)


async def sync_daily_implications_export() -> None:
    logger.info("Starting tag implications sync...")
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.get(IMPLICATIONS_EXPORT_URL, follow_redirects=True)
            response.raise_for_status()

        logger.info("Downloaded implications export. Decompressing and parsing CSV...")
        decompressed = gzip.decompress(response.content)
        csv_reader = csv.DictReader(io.StringIO(decompressed.decode("utf-8")))

        # Map structure: { "tag_name": { "implies": [...], "implied_by": [...] } }
        implications_graph: dict[str, dict[str, list[str]]] = {}

        def ensure_tag_entry(tag_name: str) -> dict[str, list[str]]:
            if tag_name not in implications_graph:
                implications_graph[tag_name] = {"implies": [], "implied_by": []}
            return implications_graph[tag_name]

        processed_count = 0
        for row in csv_reader:
            # Filter down to active implications only
            status = row.get("status", "").lower()
            if status and status != "active":
                continue

            antecedent = row.get("antecedent_name")
            consequent = row.get("consequent_name")

            if not antecedent or not consequent:
                continue

            # antecedent -> consequent (e.g., husky -> dog)
            ensure_tag_entry(antecedent)["implies"].append(consequent)
            ensure_tag_entry(consequent)["implied_by"].append(antecedent)
            processed_count += 1

        temp_msgpack_path = OUTPUT_IMPLICATIONS_MSGPACK.with_suffix(".msgpack.tmp")

        with temp_msgpack_path.open("wb") as f:
            f.write(msgspec.msgpack.encode(implications_graph))

        temp_msgpack_path.replace(OUTPUT_IMPLICATIONS_MSGPACK)

        logger.info(
            f"Successfully processed {processed_count} active implications across "
            f"{len(implications_graph)} unique tags -> {OUTPUT_IMPLICATIONS_MSGPACK}"
        )
    except Exception as e:
        logger.error(f"Failed to sync tag implications: {e}", exc_info=True)


async def is_tags_table_empty() -> bool:
    pool = get_db()
    async with pool.acquire() as conn:
        count = await conn.fetchval("SELECT COUNT(*) FROM tags;")
        return count == 0


def seconds_until_next_pull() -> float:
    """Calculates seconds remaining until the next 06:00 UTC."""
    now = datetime.now(timezone.utc)
    target = datetime.combine(now.date(), time(6, 0), tzinfo=timezone.utc)

    # If 6:00 AM UTC already passed today, target tomorrow
    if now >= target:
        target += timedelta(days=1)

    return (target - now).total_seconds()


async def run_tags_worker() -> None:
    # 1. Boot check
    if await is_tags_table_empty():
        logger.info("Tags table empty. Running startup tags sync...")
        await sync_daily_tags_export()
    else:
        logger.info("Tags table populated.")

    if not OUTPUT_IMPLICATIONS_MSGPACK.exists():
        logger.info("Tag implications file missing. Running startup implications sync...")
        await sync_daily_implications_export()
    else:
        logger.info("Tag implications file present.")

    # 2. Infinite loop calculating sleep delay
    while True:
        sleep_seconds = seconds_until_next_pull()
        hours = sleep_seconds / 3600
        logger.info(f"Sleeping for {hours:.2f} hours until 06:00 UTC...")

        await asyncio.sleep(sleep_seconds)
        await sync_daily_tags_export()
        await sync_daily_implications_export()


if __name__ == "__main__":
    asyncio.run(run_tags_worker())