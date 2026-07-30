"""Batches router migrated to async PostgreSQL."""

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from time import time
from typing import Any

from fastapi import BackgroundTasks, HTTPException, Request, APIRouter

from app.db import get_db
from app.leases import clear_expired_leases, get_client_ip
from app.post_worker import refresh_posts_metadata, refresh_batch_posts

router = APIRouter()


@router.post("/api/v1/batches/{batch_id}/claim")
async def claim_batch(batch_id: int, request: Request) -> dict[str, Any]:
    await clear_expired_leases()
    client_ip = get_client_ip(request)
    now = datetime.now(timezone.utc)

    pool = get_db()
    async with pool.acquire() as conn:
        async with conn.transaction():
            batch = await conn.fetchrow(
                "SELECT * FROM batches WHERE batch_id = $1;", batch_id
            )

            if not batch:
                raise HTTPException(status_code=404, detail="Batch not found.")

            if batch["status"] == "COMPLETE":
                raise HTTPException(status_code=400, detail="Batch is already completed.")

            project_id = batch["project_id"]

            existing_lease = await conn.fetchrow(
                """
                SELECT l.batch_id, b.batch_number 
                FROM leases l
                JOIN batches b ON l.batch_id = b.batch_id
                WHERE l.ip_address = $1 AND l.project_id = $2 AND l.expires_at > $3;
                """,
                client_ip, project_id, now,
            )

            if existing_lease and existing_lease["batch_id"] != batch_id:
                raise HTTPException(
                    status_code=400,
                    detail=f"You already hold an active lease on Batch #{existing_lease['batch_number']}.",
                )

            other_lease = await conn.fetchrow(
                "SELECT ip_address FROM leases WHERE batch_id = $1 AND expires_at > $2;",
                batch_id, now,
            )

            if other_lease and other_lease["ip_address"] != client_ip:
                raise HTTPException(
                    status_code=400, detail="Batch is currently leased by another user."
                )

            expires_at = now + timedelta(hours=1)

            await conn.execute(
                """
                INSERT INTO leases (ip_address, project_id, batch_id, expires_at)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT(ip_address, project_id) DO UPDATE SET
                    batch_id = EXCLUDED.batch_id,
                    expires_at = EXCLUDED.expires_at;
                """,
                client_ip, project_id, batch_id, expires_at,
            )

            await conn.execute(
                "UPDATE batches SET status = 'CLAIMED' WHERE batch_id = $1;",
                batch_id,
            )

    return {
        "status": "success",
        "batch_id": batch_id,
        "leased_by_ip": client_ip,
        "leased_until": expires_at.isoformat(),
    }


@router.post("/api/v1/batches/{batch_id}/revoke")
async def revoke_batch_lease(
    batch_id: int, request: Request, background_tasks: BackgroundTasks
) -> dict[str, Any]:
    client_ip = get_client_ip(request)
    now_dt = datetime.now(timezone.utc)

    pool = get_db()
    async with pool.acquire() as conn:
        async with conn.transaction():
            batch = await conn.fetchrow(
                "SELECT * FROM batches WHERE batch_id = $1;", batch_id
            )

            if not batch:
                raise HTTPException(status_code=404, detail="Batch not found.")

            lease = await conn.fetchrow(
                "SELECT * FROM leases WHERE batch_id = $1;", batch_id
            )

            if lease and lease["ip_address"] != client_ip:
                raise HTTPException(
                    status_code=403, detail="You do not hold the lease for this batch."
                )

            lease_created_at = None
            if lease and lease["expires_at"]:
                expires_at = lease["expires_at"]
                lease_created_at = expires_at - timedelta(hours=1)

            await conn.execute("DELETE FROM leases WHERE batch_id = $1;", batch_id)

            held_duration = (
                (now_dt - lease_created_at).total_seconds()
                if lease_created_at
                else 0
            )
            if held_duration >= 15:
                background_tasks.add_task(refresh_batch_posts, batch_id)
            else:
                await conn.execute(
                    "UPDATE batches SET status = 'AVAILABLE' WHERE batch_id = $1;",
                    batch_id,
                )

    return {"status": "success", "batch_id": batch_id}


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


@router.post("/api/v1/batches/{batch_id}/refresh")
async def refresh_batch(batch_id: int, request: Request) -> dict[str, Any]:
    client_ip = get_client_ip(request)
    if not check_batch_rate_limit(client_ip):
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded. Please wait before refreshing this batch again.",
        )

    pool = get_db()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT cp.post_id 
            FROM cluster_posts cp
            JOIN clusters c ON cp.cluster_id = c.cluster_id
            WHERE c.batch_id = $1;
            """,
            batch_id,
        )
        post_ids = [r["post_id"] for r in rows]

    if not post_ids:
        raise HTTPException(
            status_code=404, detail="Batch not found or contains no posts."
        )

    await refresh_posts_metadata(post_ids)

    return {"status": "success", "batch_id": batch_id}