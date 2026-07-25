"""Lightweight observability: request-id + structured access logs, an in-process
metrics counter, and a /metrics endpoint. No external APM dependency for v1;
the log format is JSON so it drops straight into any log aggregator.
"""

import logging
import time
import uuid
from collections import defaultdict

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger("rxhive.access")

_counters: dict[str, int] = defaultdict(int)
_latency_ms_total: dict[str, float] = defaultdict(float)

# Counters live for the process lifetime and are never evicted, so a per-request
# key must come from a bounded set. Requests that matched no route (404s to
# arbitrary URLs) have no route template, and keying them by raw path let anyone
# who can reach the port mint unbounded keys — a memory leak, unauthenticated.
# They all share this one label; the raw path still reaches the access log.
UNMATCHED_ROUTE_LABEL = "<unmatched>"


def incr(name: str, by: int = 1) -> None:
    _counters[name] += by


def snapshot() -> dict:
    return {
        "counters": dict(_counters),
        "latency_ms_avg": {
            k: round(_latency_ms_total[k] / _counters[k], 2) for k in _latency_ms_total if _counters.get(k)
        },
    }


class AccessLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
        start = time.perf_counter()
        try:
            response = await call_next(request)
            status = response.status_code
        except Exception:
            incr("http_requests_error")
            logger.exception("request failed", extra={"request_id": request_id, "path": request.url.path})
            raise
        elapsed_ms = (time.perf_counter() - start) * 1000

        route = request.scope.get("route")
        route_path = getattr(route, "path", None)
        key = f"{request.method} {route_path or UNMATCHED_ROUTE_LABEL}"
        incr("http_requests_total")
        incr(f"status_{status // 100}xx")
        _counters[key] += 1
        _latency_ms_total[key] += elapsed_ms

        response.headers["X-Request-ID"] = request_id
        # Structured single-line access log (path template, not raw path, so
        # ids don't explode cardinality; never logs query strings or bodies).
        logger.info(
            "access",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": route_path or request.url.path,
                "status": status,
                "ms": round(elapsed_ms, 1),
            },
        )
        return response
