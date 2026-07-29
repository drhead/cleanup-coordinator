"""Main FastAPI application module handling routes, background tasks, and API endpoints."""

import asyncio
import base64
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from time import time
from typing import Any, Awaitable, Callable

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import httpx
import msgspec
from pydantic import BaseModel

from app.blacklist import E621BlacklistEvaluator, get_cluster_union_tags_and_rating
from app.db import get_db
from app.flag_worker import flag_poller_loop
from app.rate_limiter import e621_limiter

SECRETS_PATH = Path("secrets.json")
secrets_data = json.loads(SECRETS_PATH.read_text(encoding="utf-8"))
USER_AGENT = f"cleanup-coordinator_post-update/1.1 (by {secrets_data['e621_username']})"

POSTS_URL = "https://e621.net/posts.json"
POST_FLAGS_URL = "https://e621.net/post_flags.json"
CHUNK_LIMIT = 320

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


# --- Data Structures & Schemas ---


class PostRelationships(msgspec.Struct):
    parent_id: int | None = None


class PostFlags(msgspec.Struct):
    flagged: bool
    deleted: bool


class PostData(msgspec.Struct):
    id: int
    rating: str
    tags: dict[str, list[str]]
    pools: list[int]
    relationships: PostRelationships
    flags: PostFlags


class BulkPostContainer(msgspec.Struct):
    posts: list[PostData]


class BlacklistCheckRequest(BaseModel):
    blacklist: str
    batch_id: int


class E621PostFlagItem(msgspec.Struct, kw_only=True):
    """Schema matching array elements returned from e621's /post_flags.json endpoint."""

    id: int
    post_id: int
    is_resolved: bool
    is_deletion: bool


flag_decoder = msgspec.json.Decoder(type=list[E621PostFlagItem])


# --- Helper Functions & Background Services ---


async def fetch_and_sync_post_flags(
    post_id: int, client: httpx.AsyncClient
) -> None:
    """Queries e621 for a post's flags and upserts them into the database."""
    await e621_limiter.wait_async()

    response = await client.get(POST_FLAGS_URL, params={"search[post_id]": post_id})
    if response.status_code != 200:
        return

    flag_items = flag_decoder.decode(response.content)
    with get_db() as conn:
        for item in flag_items:
            conn.execute(
                """
                INSERT INTO post_flags (flag_id, post_id, is_resolved, is_deletion)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(flag_id) DO UPDATE SET
                    is_resolved = excluded.is_resolved,
                    is_deletion = excluded.is_deletion;
                """,
                (item.id, item.post_id, item.is_resolved, item.is_deletion),
            )


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
            container = msgspec.json.decode(response.content, type=BulkPostContainer)

            chunk_post_ids = [post.id for post in container.posts]
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

            for post in container.posts:
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


def get_client_ip(request: Request) -> str:
    """Extracts client IP address respecting reverse proxies."""
    cf_ip = request.headers.get("cf-connecting-ip")
    if cf_ip:
        return cf_ip.strip()
    x_forwarded = request.headers.get("x-forwarded-for")
    if x_forwarded:
        return x_forwarded.split(",")[0].strip()
    return request.client.host if request.client else "127.0.0.1"


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


async def clear_expired_leases() -> None:
    """Removes expired leases and schedules background refresh."""
    now_dt = datetime.now(timezone.utc)
    now_iso = now_dt.isoformat()

    with get_db() as conn:
        expired = conn.execute(
            "SELECT batch_id FROM leases WHERE expires_at <= ?;", (now_iso,)
        ).fetchall()
        expired_batch_ids = [r[0] for r in expired]

        if expired_batch_ids:
            conn.execute(
                "DELETE FROM leases WHERE expires_at <= ?;", (now_iso,)
            )
            for bid in expired_batch_ids:
                asyncio.create_task(refresh_batch_posts_background(bid))


async def lease_poller_loop() -> None:
    """Background worker that periodically checks and clears expired leases."""
    while True:
        try:
            await clear_expired_leases()
        except Exception as e:
            print(f"[Lease Poller] Error clearing expired leases: {e}")
        await asyncio.sleep(15)


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


# Rate Limiting state for batch refreshes
batch_rate_limits: dict[str, list[float]] = defaultdict(list)
BATCH_RATE_WINDOW = 30.0
BATCH_RATE_NUM = 5


def check_batch_rate_limit(client_ip: str) -> bool:
    """Enforces rate limiting for batch refresh operations per IP."""
    now = time()
    window_start = now - BATCH_RATE_WINDOW
    batch_rate_limits[client_ip] = [
        t for t in batch_rate_limits[client_ip] if t > window_start
    ]
    if len(batch_rate_limits[client_ip]) >= BATCH_RATE_NUM:
        return False
    batch_rate_limits[client_ip].append(now)
    return True


# --- FastAPI Application Lifecycle & Middleware ---


@asynccontextmanager
async def lifespan(app: FastAPI):
    poller_task = asyncio.create_task(flag_poller_loop())
    lease_task = asyncio.create_task(lease_poller_loop())

    yield

    poller_task.cancel()
    lease_task.cancel()
    try:
        await asyncio.gather(poller_task, lease_task, return_exceptions=True)
    except asyncio.CancelledError:
        pass


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


@app.middleware("http")
async def enforce_https_for_cloudflare(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    forwarded_proto = request.headers.get("x-forwarded-proto", "").lower()

    if forwarded_proto == "http":
        url = request.url.replace(scheme="https")
        return RedirectResponse(url=str(url), status_code=301)

    return await call_next(request)


# --- API Routes ---


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/v1/projects")
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


@app.get("/api/v1/projects/{project_id}/batches")
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


@app.post("/api/v1/batches/{batch_id}/claim")
async def claim_batch(batch_id: int, request: Request) -> dict[str, Any]:
    await clear_expired_leases()
    client_ip = get_client_ip(request)
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    with get_db() as conn:
        batch = conn.execute(
            "SELECT * FROM batches WHERE batch_id = ?", (batch_id,)
        ).fetchone()

        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found.")

        if batch["status"] == "COMPLETE":
            raise HTTPException(status_code=400, detail="Batch is already completed.")

        project_id = batch["project_id"]

        existing_lease = conn.execute(
            """
            SELECT l.batch_id, b.batch_number 
            FROM leases l
            JOIN batches b ON l.batch_id = b.batch_id
            WHERE l.ip_address = ? AND l.project_id = ? AND l.expires_at > ?
            """,
            (client_ip, project_id, now_iso),
        ).fetchone()

        if existing_lease and existing_lease["batch_id"] != batch_id:
            raise HTTPException(
                status_code=400,
                detail=f"You already hold an active lease on Batch #{existing_lease['batch_number']}.",
            )

        other_lease = conn.execute(
            "SELECT ip_address FROM leases WHERE batch_id = ? AND expires_at > ?",
            (batch_id, now_iso),
        ).fetchone()

        if other_lease and other_lease["ip_address"] != client_ip:
            raise HTTPException(
                status_code=400, detail="Batch is currently leased by another user."
            )

        expires_at = (now + timedelta(hours=1)).isoformat()

        conn.execute(
            """
            INSERT INTO leases (ip_address, project_id, batch_id, expires_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(ip_address, project_id) DO UPDATE SET
                batch_id = excluded.batch_id,
                expires_at = excluded.expires_at
            """,
            (client_ip, project_id, batch_id, expires_at),
        )

        conn.execute(
            "UPDATE batches SET status = 'CLAIMED' WHERE batch_id = ?",
            (batch_id,),
        )

    return {
        "status": "success",
        "batch_id": batch_id,
        "leased_by_ip": client_ip,
        "leased_until": expires_at,
    }


@app.post("/api/v1/batches/{batch_id}/revoke")
def revoke_batch_lease(
    batch_id: int, request: Request, background_tasks: BackgroundTasks
) -> dict[str, Any]:
    client_ip = get_client_ip(request)
    now_dt = datetime.now(timezone.utc)

    with get_db() as conn:
        batch = conn.execute(
            "SELECT * FROM batches WHERE batch_id = ?;", (batch_id,)
        ).fetchone()

        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found.")

        lease = conn.execute(
            "SELECT * FROM leases WHERE batch_id = ?;", (batch_id,)
        ).fetchone()

        if lease and lease["ip_address"] != client_ip:
            raise HTTPException(
                status_code=403, detail="You do not hold the lease for this batch."
            )

        lease_created_at = None
        if lease:
            expires_at = datetime.fromisoformat(lease["expires_at"])
            lease_created_at = expires_at - timedelta(hours=1)

        conn.execute("DELETE FROM leases WHERE batch_id = ?;", (batch_id,))

        held_duration = (
            (now_dt - lease_created_at).total_seconds()
            if lease_created_at
            else 0
        )
        if held_duration >= 15:
            background_tasks.add_task(refresh_batch_posts_background, batch_id)
        else:
            conn.execute(
                "UPDATE batches SET status = 'AVAILABLE' WHERE batch_id = ?;",
                (batch_id,),
            )

    return {"status": "success", "batch_id": batch_id}


@app.get("/api/v1/leases")
async def get_leases(request: Request) -> dict[str, list[dict[str, Any]]]:
    await clear_expired_leases()
    client_ip = get_client_ip(request)

    with get_db() as conn:
        leases = conn.execute(
            """
            SELECT 
                l.project_id,
                l.batch_id,
                l.expires_at AS leased_until,
                b.batch_number,
                (l.ip_address = ?) AS is_leased_by_you
            FROM leases l
            JOIN batches b ON l.batch_id = b.batch_id
            ORDER BY l.expires_at ASC
            """,
            (client_ip,),
        ).fetchall()

        return {"leases": [dict(l) for l in leases]}


@app.post("/api/v1/batches/{batch_id}/refresh")
async def refresh_batch(batch_id: str, request: Request) -> dict[str, Any]:
    client_ip = get_client_ip(request)
    if not check_batch_rate_limit(client_ip):
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded. Please wait before refreshing this batch again.",
        )

    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT cp.post_id 
            FROM cluster_posts cp
            JOIN clusters c ON cp.cluster_id = c.cluster_id
            WHERE c.batch_id = ?;
            """,
            (batch_id,),
        ).fetchall()
        post_ids = [r[0] for r in rows]

    if not post_ids:
        raise HTTPException(
            status_code=404, detail="Batch not found or contains no posts."
        )

    await fetch_and_update_posts_metadata_bulk(post_ids)

    return {"status": "success", "batch_id": batch_id}