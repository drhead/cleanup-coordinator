"""Database connection management and schema initialization."""

from pathlib import Path
import sqlite3

DB_PATH = Path("data/coordinator.db")
SCHEMA_PATH = Path("app/schema.sql")


def get_db() -> sqlite3.Connection:
    """Connect to SQLite database with WAL mode and foreign keys enabled."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_db() -> None:
    """Read schema file and execute initial DDL scripts."""
    schema_sql = SCHEMA_PATH.read_text(encoding="utf-8")

    with get_db() as conn:
        conn.executescript(schema_sql)


if __name__ == "__main__":
    init_db()
    print("Database initialized successfully.")