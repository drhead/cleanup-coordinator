import asyncio
from datetime import datetime, timezone

from fastapi import Request

from app.db import get_db
from app.post_worker import refresh_batch_posts_background

def get_client_ip(request: Request) -> str:
    """Extracts client IP address respecting reverse proxies."""
    cf_ip = request.headers.get("cf-connecting-ip")
    if cf_ip:
        return cf_ip.strip()
    x_forwarded = request.headers.get("x-forwarded-for")
    if x_forwarded:
        return x_forwarded.split(",")[0].strip()
    return request.client.host if request.client else "127.0.0.1"


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