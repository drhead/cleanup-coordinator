"""Global rate limiter module for thread-safe and async request pacing."""

import asyncio
import threading
import time


class E621RateLimiter:
    """Enforces a strict global maximum request rate across threads and async tasks."""

    def __init__(self, requests_per_second: float = 1.0) -> None:
        self.interval: float = 1.0 / requests_per_second
        self._last_call: float = 0.0
        self._thread_lock = threading.Lock()
        self._async_lock = asyncio.Lock()

    def wait_sync(self) -> None:
        """Blocks synchronously until the required time interval has elapsed."""
        with self._thread_lock:
            now = time.monotonic()
            elapsed = now - self._last_call
            wait_time = self.interval - elapsed

            if wait_time > 0:
                time.sleep(wait_time)

            self._last_call = time.monotonic()

    async def wait_async(self) -> None:
        """Awaits asynchronously until the required time interval has elapsed."""
        async with self._async_lock:
            with self._thread_lock:
                now = time.monotonic()
                elapsed = now - self._last_call
                wait_time = self.interval - elapsed

            if wait_time > 0:
                await asyncio.sleep(wait_time)

            with self._thread_lock:
                self._last_call = time.monotonic()


# The single application-wide instance
e621_limiter = E621RateLimiter(requests_per_second=1.0)