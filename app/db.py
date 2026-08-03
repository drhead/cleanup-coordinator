"""Async PostgreSQL connection pool and schema initialization management."""

from pathlib import Path
import asyncpg
import asyncio
from app.secrets import secrets

SECRETS_PATH = Path("secrets.json")
SCHEMA_PATH = Path("app/schema.sql")

_pool: asyncpg.Pool | None = None


async def init_db_pool() -> None:
    """Initialize the global asyncpg connection pool."""
    global _pool
    if _pool is not None:
        return

    _pool = await asyncpg.create_pool(
        user=secrets.postgresql_user,
        password=secrets.postgresql_password,
        database="coordinator_db",
        host="localhost",
        port=5433,
        min_size=10,
        max_size=50,
    )


async def close_db_pool() -> None:
    """Close the global connection pool gracefully with a fallback timeout."""
    global _pool
    if _pool is not None:
        try:
            # Give ReadySet 1.5s to shut connections down gracefully
            await asyncio.wait_for(_pool.close(), timeout=1.5)
        except asyncio.TimeoutError:
            # Force-terminate underlying transports if proxy connection stalls
            _pool.terminate()
        finally:
            _pool = None


def get_db() -> asyncpg.Pool:
    """Get the active connection pool."""
    if _pool is None:
        raise RuntimeError("Database pool has not been initialized. Call init_db_pool() first.")
    return _pool


async def init_db() -> None:
    """Read schema file and execute initial DDL scripts."""
    schema_sql = SCHEMA_PATH.read_text(encoding="utf-8")
    conn: asyncpg.Connection
    # Connect directly to run the whole DDL script
    conn = await asyncpg.connect(
        user=secrets.postgresql_user,
        password=secrets.postgresql_password,
        database="coordinator_db",
        host="localhost",
        port=5432,
    )
    try:
        await conn.execute(schema_sql)
    finally:
        await conn.close()


if __name__ == "__main__":
    import asyncio
    asyncio.run(init_db())
    print("PostgreSQL database initialized successfully.")