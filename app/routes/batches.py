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


@router.post("/api/v1/batches/{batch_id}/revoke")
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
            background_tasks.add_task(refresh_batch_posts, batch_id)
        else:
            conn.execute(
                "UPDATE batches SET status = 'AVAILABLE' WHERE batch_id = ?;",
                (batch_id,),
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

    await refresh_posts_metadata(post_ids)

    return {"status": "success", "batch_id": batch_id}