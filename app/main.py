import asyncio
from contextlib import asynccontextmanager
from typing import Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from app.flag_worker import flag_poller_loop
from app.leases import lease_poller_loop
from app.routes import batches, leases, projects, views


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

# Static files
app.mount("/static", StaticFiles(directory="static"), name="static")

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