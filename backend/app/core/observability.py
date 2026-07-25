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


def incr(name: str, by: int = 1) -> None:
    _counters[name] += by


def snapshot() -> dict:
    return {
        "counters": dict(_counters),
        "latency_ms_avg": {
            k: round(_latency_ms_total[k] / _counters[k], 2)
            for k in _latency_ms_total
            if _counters.get(k)
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
            logger.exception(
                "request failed", extra={"request_id": request_id, "path": request.url.path}
            )
            raise
        elapsed_ms = (time.perf_counter() - start) * 1000

        route = request.scope.get("route")
        label = getattr(route, "path", request.url.path)
        key = f"{request.method} {label}"
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
                "path": label,
                "status": status,
                "ms": round(elapsed_ms, 1),
            },
        )
        return response
