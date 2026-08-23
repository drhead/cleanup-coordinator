import asyncio
from contextlib import asynccontextmanager
from typing import Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from app.flag_worker import flag_poller_loop
from app.post_worker import post_worker_loop
from app.tags_worker import run_tags_worker
from app.leases import lease_poller_loop
from app.edit_worker import edit_poller_loop
from app.routes import batches, leases, projects, views, static_data
from app.db import init_db_pool, close_db_pool

 
@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db_pool()
    poller_task = asyncio.create_task(flag_poller_loop())
    lease_task = asyncio.create_task(lease_poller_loop())
    tags_task = asyncio.create_task(run_tags_worker())
    posts_task = asyncio.create_task(post_worker_loop())
    edit_task = asyncio.create_task(edit_poller_loop())

    yield

    poller_task.cancel()
    lease_task.cancel()
    tags_task.cancel()
    posts_task.cancel()
    edit_task.cancel()
    try:
        await asyncio.gather(
            poller_task,
            lease_task,
            tags_task,
            posts_task,
            edit_task,
            return_exceptions=True
        )
    except asyncio.CancelledError:
        pass

    await close_db_pool()


app = FastAPI(lifespan=lifespan)



# Middleware
@app.middleware("http")
async def enforce_https(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    forwarded_proto = request.headers.get("x-forwarded-proto", "").lower()

    if forwarded_proto == "http":
        url = request.url.replace(scheme="https")
        return RedirectResponse(url=str(url), status_code=301)

    return await call_next(request)

# Include Routers
app.include_router(views.router)
app.include_router(projects.router)
app.include_router(batches.router)
app.include_router(leases.router)
app.include_router(static_data.router)

# Static files
from pathlib import Path

if Path("dist/assets").is_dir():
    app.mount("/assets", StaticFiles(directory="dist/assets"), name="assets")

app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/components", StaticFiles(directory="templates/components"), name="components")