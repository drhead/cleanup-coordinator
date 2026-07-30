"""Leases router migrated to async PostgreSQL."""

from typing import Any

from fastapi import APIRouter, Request
import asyncpg

from app.db import get_db
from app.leases import clear_expired_leases, get_client_ip

router = APIRouter()


@router.get("/api/v1/leases")
async def get_leases(request: Request) -> dict[str, list[dict[str, Any]]]:
    await clear_expired_leases()
    client_ip = get_client_ip(request)

    pool = get_db()
    async with pool.acquire() as conn:
        conn: asyncpg.Connection
        rows = await conn.fetch(
            """
            SELECT 
                l.project_id,
                l.batch_id,
                l.expires_at AS leased_until,
                b.batch_number,
                (l.ip_address = $1) AS is_leased_by_you
            FROM leases l
            JOIN batches b ON l.batch_id = b.batch_id
            ORDER BY l.expires_at ASC
            """,
            client_ip,
        )

        leases_list = []
        for r in rows:
            d = dict(r)
            if d.get("leased_until"):
                d["leased_until"] = d["leased_until"].isoformat()
            leases_list.append(d)

        return {"leases": leases_list}