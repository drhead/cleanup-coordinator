import asyncio
import csv
import gzip
import io
import logging
from datetime import datetime, time, timedelta, timezone
from pathlib import Path

import brotli
import httpx
import msgspec

from app.db import get_db

logger = logging.getLogger("tags_worker")

TAGS_EXPORT_URL = "https://static1.e621.net/data/db_export/tags.csv.gz"
IMPLICATIONS_EXPORT_URL = (
    "https://static1.e621.net/data/db_export/tag_implications.csv.gz"
)

OUTPUT_IMPLICATIONS_MSGPACK = Path("static/data/tag_implications.msgpack")
OUTPUT_TAGS_MSGPACK = Path("static/data/tags.msgpack")

OUTPUT_IMPLICATIONS_MSGPACK.parent.mkdir(parents=True, exist_ok=True)

# Map integer category IDs to DB string categories
CATEGORY_MAP = {
    0: "general",
    1: "artist",
    2: "contributor",
    3: "copyright",
    4: "character",
    5: "species",
    6: "invalid",
    7: "meta",
    8: "lore",
}


def write_precompressed_assets(base_path: Path, raw_bytes: bytes) -> None:
    """Writes pre-compressed .gz and .br variants alongside the raw file using atomic replacement."""
    # 1. Gzip (level 9)
    gz_tmp = base_path.with_suffix(".msgpack.gz.tmp")
    gz_target = Path(f"{base_path}.gz")
    gz_tmp.write_bytes(gzip.compress(raw_bytes, compresslevel=9))
    gz_tmp.replace(gz_target)

    # 2. Brotli (quality 11)
    br_tmp = base_path.with_suffix(".msgpack.br.tmp")
    br_target = Path(f"{base_path}.br")
    br_tmp.write_bytes(brotli.compress(raw_bytes, quality=11))
    br_tmp.replace(br_target)


async def sync_daily_tags_export() -> None:
    logger.info("Starting tags sync...")
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.get(TAGS_EXPORT_URL, follow_redirects=True)
            response.raise_for_status()

        logger.info("Downloaded tags export. Decompressing and parsing CSV...")
        decompressed = gzip.decompress(response.content)
        csv_reader = csv.DictReader(io.StringIO(decompressed.decode("utf-8")))

        tag_names: list[str] = []
        categories: list[int] = []
        post_counts: list[int] = []
        lean_tags_data: dict[str, list[int]] = {}

        for row in csv_reader:
            try:
                cat_id = int(row.get("category", 0))
            except ValueError:
                cat_id = 0

            if cat_id < 0 or cat_id > 8:
                cat_id = 0

            tag_name = row.get("name", "")

            try:
                post_count = int(row.get("post_count", 0))
            except ValueError:
                post_count = 0

            if not tag_name:
                continue

            tag_names.append(tag_name)
            categories.append(cat_id)
            post_counts.append(post_count)

            if cat_id != 6:
                lean_tags_data[tag_name] = [cat_id, post_count]

        # 1. Update DB Table using unnest
        pool = get_db()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    INSERT INTO tags (tag_name, category, post_count)
                    SELECT * FROM unnest($1::text[], $2::int[], $3::bigint[])
                    ON CONFLICT (tag_name) DO UPDATE SET
                        category = EXCLUDED.category,
                        post_count = EXCLUDED.post_count;
                    """,
                    tag_names,
                    categories,
                    post_counts,
                )

        # 2. Write raw static MessagePack asset atomically
        raw_bytes = msgspec.msgpack.encode(lean_tags_data)
        temp_msgpack_path = OUTPUT_TAGS_MSGPACK.with_suffix(".msgpack.tmp")
        temp_msgpack_path.write_bytes(raw_bytes)
        temp_msgpack_path.replace(OUTPUT_TAGS_MSGPACK)

        # 3. Pre-compress .gz and .br variants
        logger.info("Pre-compressing static tags asset with Gzip and Brotli (q=11)...")
        write_precompressed_assets(OUTPUT_TAGS_MSGPACK, raw_bytes)

        logger.info(
            f"Successfully synced {len(tag_names)} DB tags and wrote pre-compressed assets for "
            f"{len(lean_tags_data)} active tags -> {OUTPUT_TAGS_MSGPACK}"
        )
    except Exception as e:
        logger.error(f"Failed to sync tags: {e}", exc_info=True)


async def sync_daily_implications_export() -> None:
    logger.info("Starting tag implications sync...")
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.get(
                IMPLICATIONS_EXPORT_URL, follow_redirects=True
            )
            response.raise_for_status()

        logger.info(
            "Downloaded implications export. Decompressing and parsing CSV..."
        )
        decompressed = gzip.decompress(response.content)
        csv_reader = csv.DictReader(io.StringIO(decompressed.decode("utf-8")))

        implications_graph: dict[str, dict[str, list[str]]] = {}

        def ensure_tag_entry(tag_name: str) -> dict[str, list[str]]:
            if tag_name not in implications_graph:
                implications_graph[tag_name] = {"implies": [], "implied_by": []}
            return implications_graph[tag_name]

        processed_count = 0
        for row in csv_reader:
            status = row.get("status", "").lower()
            if status and status != "active":
                continue

            antecedent = row.get("antecedent_name")
            consequent = row.get("consequent_name")

            if not antecedent or not consequent:
                continue

            ensure_tag_entry(antecedent)["implies"].append(consequent)
            ensure_tag_entry(consequent)["implied_by"].append(antecedent)
            processed_count += 1

        # 1. Write raw static MessagePack asset atomically
        raw_bytes = msgspec.msgpack.encode(implications_graph)
        temp_msgpack_path = OUTPUT_IMPLICATIONS_MSGPACK.with_suffix(
            ".msgpack.tmp"
        )
        temp_msgpack_path.write_bytes(raw_bytes)
        temp_msgpack_path.replace(OUTPUT_IMPLICATIONS_MSGPACK)

        # 2. Pre-compress .gz and .br variants
        logger.info("Pre-compressing tag implications asset with Gzip and Brotli (q=11)...")
        write_precompressed_assets(OUTPUT_IMPLICATIONS_MSGPACK, raw_bytes)

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

    if now >= target:
        target += timedelta(days=1)

    return (target - now).total_seconds()


async def run_tags_worker() -> None:
    tags_br = Path(f"{OUTPUT_TAGS_MSGPACK}.br")
    implications_br = Path(f"{OUTPUT_IMPLICATIONS_MSGPACK}.br")

    if (
        await is_tags_table_empty()
        or not OUTPUT_TAGS_MSGPACK.exists()
        or not tags_br.exists()
    ):
        logger.info("Tags missing in DB or on disk. Running startup tags sync...")
        await sync_daily_tags_export()
    else:
        logger.info("Tags table and pre-compressed static files present.")

    if not OUTPUT_IMPLICATIONS_MSGPACK.exists() or not implications_br.exists():
        logger.info(
            "Tag implications missing on disk. Running startup implications sync..."
        )
        await sync_daily_implications_export()
    else:
        logger.info("Tag implications pre-compressed static files present.")

    while True:
        sleep_seconds = seconds_until_next_pull()
        hours = sleep_seconds / 3600
        logger.info(f"Sleeping for {hours:.2f} hours until 06:00 UTC...")

        await asyncio.sleep(sleep_seconds)
        await sync_daily_tags_export()
        await sync_daily_implications_export()


if __name__ == "__main__":
    asyncio.run(run_tags_worker())