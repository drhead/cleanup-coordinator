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
ALIASES_EXPORT_URL = (
    "https://static1.e621.net/data/db_export/tag_aliases.csv.gz"
)

OUTPUT_CONSOLIDATED_MSGPACK = Path("static/data/tags_bundle.msgpack")
OUTPUT_CONSOLIDATED_MSGPACK.parent.mkdir(parents=True, exist_ok=True)

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


class TagMetadata(msgspec.Struct):
    category: int
    count: int
    implied_by: list[str] = []
    implies: list[str] = []
    alias_to: str | None = None


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


def resolve_alias_target(
    initial_tag: str, direct_aliases: dict[str, str]
) -> str | None:
    """Recursively resolves an alias target to handle alias chains (e.g. A -> B -> C).
    
    Includes cycle detection to protect against circular alias references in DB export.
    """
    current = initial_tag
    visited: set[str] = set()

    while current in direct_aliases:
        if current in visited:
            logger.warning(f"Circular alias detected involving tag: '{current}'")
            break
        visited.add(current)
        current = direct_aliases[current]

    return current if current != initial_tag else None


async def sync_daily_tags_bundle() -> None:
    logger.info("Starting consolidated tags data sync...")
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            # Step 1: Download all exports in parallel
            logger.info("Downloading tags, implications, and aliases dumps...")
            res_tags, res_impl, res_alias = await asyncio.gather(
                client.get(TAGS_EXPORT_URL, follow_redirects=True),
                client.get(IMPLICATIONS_EXPORT_URL, follow_redirects=True),
                client.get(ALIASES_EXPORT_URL, follow_redirects=True),
            )

            res_tags.raise_for_status()
            res_impl.raise_for_status()
            res_alias.raise_for_status()

        # ------------------------------------------------------------------
        # 1. Parse Aliases (antecedent -> consequent)
        # ------------------------------------------------------------------
        logger.info("Parsing active tag aliases...")
        decomp_alias = gzip.decompress(res_alias.content)
        alias_reader = csv.DictReader(io.StringIO(decomp_alias.decode("utf-8")))

        raw_aliases: dict[str, str] = {}
        for row in alias_reader:
            status = row.get("status", "").lower()
            if status and status != "active":
                continue

            antecedent = row.get("antecedent_name")
            consequent = row.get("consequent_name")
            if antecedent and consequent:
                raw_aliases[antecedent] = consequent

        # Resolve multi-hop/chained aliases (A -> B -> C resolves to A -> C)
        resolved_aliases: dict[str, str] = {}
        for tag in raw_aliases:
            final_target = resolve_alias_target(tag, raw_aliases)
            if final_target:
                resolved_aliases[tag] = final_target

        logger.info(f"Resolved {len(resolved_aliases)} active tag aliases.")

        # ------------------------------------------------------------------
        # 2. Parse Implications
        # ------------------------------------------------------------------
        logger.info("Parsing active tag implications...")
        decomp_impl = gzip.decompress(res_impl.content)
        impl_reader = csv.DictReader(io.StringIO(decomp_impl.decode("utf-8")))

        implies_map: dict[str, list[str]] = {}
        implied_by_map: dict[str, list[str]] = {}

        for row in impl_reader:
            status = row.get("status", "").lower()
            if status and status != "active":
                continue

            antecedent = row.get("antecedent_name")
            consequent = row.get("consequent_name")

            if not antecedent or not consequent:
                continue

            implies_map.setdefault(antecedent, []).append(consequent)
            implied_by_map.setdefault(consequent, []).append(antecedent)

        # ------------------------------------------------------------------
        # 3. Parse Base Tags & Sync Postgres DB
        # ------------------------------------------------------------------
        logger.info("Parsing tags CSV and updating Postgres database...")
        decomp_tags = gzip.decompress(res_tags.content)
        tags_reader = csv.DictReader(io.StringIO(decomp_tags.decode("utf-8")))

        tag_names: list[str] = []
        categories: list[int] = []
        post_counts: list[int] = []

        # Intermediate lookup map before consolidation
        base_tags_map: dict[str, tuple[int, int]] = {}

        for row in tags_reader:
            tag_name = row.get("name", "")
            if not tag_name:
                continue

            try:
                cat_id = int(row.get("category", 0))
            except ValueError:
                cat_id = 0

            if cat_id < 0 or cat_id > 8:
                cat_id = 0

            try:
                post_count = int(row.get("post_count", 0))
            except ValueError:
                post_count = 0

            tag_names.append(tag_name)
            categories.append(cat_id)
            post_counts.append(post_count)

            base_tags_map[tag_name] = (cat_id, post_count)

        # 1. Execute DB Update
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

        # ------------------------------------------------------------------
        # 4. Consolidate into TagMetadata and Apply Pruning Rules
        # ------------------------------------------------------------------
        logger.info("Consolidating tag graph into unified TagMetadata dict...")

        # Find all unique tag names across tags, aliases, and implications
        all_known_tags = (
            set(base_tags_map.keys())
            | set(resolved_aliases.keys())
            | set(implies_map.keys())
            | set(implied_by_map.keys())
        )

        consolidated_bundle: dict[str, TagMetadata] = {}

        for tag in all_known_tags:
            cat_id, count = base_tags_map.get(tag, (0, 0))
            alias_to = resolved_aliases.get(tag)

            # Rule: Drop if NO alias_to AND (count == 0 OR category == 6 (invalid))
            if alias_to is None and (count == 0 or cat_id == 6):
                continue

            consolidated_bundle[tag] = TagMetadata(
                category=cat_id,
                count=count,
                implied_by=implied_by_map.get(tag, []),
                implies=implies_map.get(tag, []),
                alias_to=alias_to,
            )

        # ------------------------------------------------------------------
        # 5. Write and Pre-compress Output File
        # ------------------------------------------------------------------
        logger.info("Encoding consolidated bundle to MessagePack...")
        raw_bytes = msgspec.msgpack.encode(consolidated_bundle)

        temp_msgpack_path = OUTPUT_CONSOLIDATED_MSGPACK.with_suffix(
            ".msgpack.tmp"
        )
        temp_msgpack_path.write_bytes(raw_bytes)
        temp_msgpack_path.replace(OUTPUT_CONSOLIDATED_MSGPACK)

        logger.info(
            "Pre-compressing consolidated tags asset with Gzip and Brotli (q=11)..."
        )
        write_precompressed_assets(OUTPUT_CONSOLIDATED_MSGPACK, raw_bytes)

        logger.info(
            f"Successfully synced {len(tag_names)} DB tags and created consolidated bundle for "
            f"{len(consolidated_bundle)} active/aliased tags -> {OUTPUT_CONSOLIDATED_MSGPACK}"
        )

    except Exception as e:
        logger.error(f"Failed to sync tags bundle: {e}", exc_info=True)


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
    bundle_br = Path(f"{OUTPUT_CONSOLIDATED_MSGPACK}.br")

    if (
        await is_tags_table_empty()
        or not OUTPUT_CONSOLIDATED_MSGPACK.exists()
        or not bundle_br.exists()
    ):
        logger.info(
            "Tags missing in DB or pre-compressed bundle missing on disk. Running startup sync..."
        )
        await sync_daily_tags_bundle()
    else:
        logger.info(
            "Tags DB table and pre-compressed static files are present."
        )

    while True:
        sleep_seconds = seconds_until_next_pull()
        hours = sleep_seconds / 3600
        logger.info(f"Sleeping for {hours:.2f} hours until 06:00 UTC...")

        await asyncio.sleep(sleep_seconds)
        await sync_daily_tags_bundle()


if __name__ == "__main__":
    asyncio.run(run_tags_worker())