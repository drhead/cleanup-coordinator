import asyncio
import csv
import gzip
import io
import logging
from datetime import datetime, time, timedelta, timezone

import httpx

from app.db import get_db

logger = logging.getLogger("tags_worker")

TAGS_EXPORT_URL = "https://static1.e621.net/data/db_export/tags.csv.gz"

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

        logger.info("Downloaded export. Decompressing and parsing CSV...")
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
        logger.info("Tags table empty. Running startup sync...")
        await sync_daily_tags_export()
    else:
        logger.info("Tags table populated.")

    # 2. Infinite loop calculating sleep delay
    while True:
        sleep_seconds = seconds_until_next_pull()
        hours = sleep_seconds / 3600
        logger.info(f"Sleeping for {hours:.2f} hours until 06:00 UTC...")
        
        await asyncio.sleep(sleep_seconds)
        await sync_daily_tags_export()


if __name__ == "__main__":
    asyncio.run(run_tags_worker())