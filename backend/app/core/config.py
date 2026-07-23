from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="RXHIVE_", env_file=".env", extra="ignore")

    app_name: str = "RX HIVE"
    environment: str = "development"  # development | production | test

    database_url: str = "postgresql+asyncpg://rxhive:rxhive@localhost:5432/rxhive"
    redis_url: str = "redis://localhost:6379/0"

    secret_key: str = "dev-only-secret-change-in-production"
    access_token_minutes: int = 15
    refresh_token_days: int = 30

    cookie_secure: bool = False
    cookie_domain: str | None = None

    cors_origins: str = ""  # comma-separated exact origins; empty = same-origin only

    s3_endpoint: str = "http://localhost:9000"
    # Endpoint the *browser* uses for presigned URLs. May be a bare path like "/s3"
    # (the bundled Caddy route) or a full origin like "https://cdn.example.com".
    s3_public_endpoint: str = "http://localhost:9000"
    s3_access_key: str = "rxhive"
    s3_secret_key: str = "rxhive-dev"
    s3_bucket: str = "rxhive-attachments"
    s3_region: str = "us-east-1"
    presign_expiry_seconds: int = 300

    livekit_url: str = "ws://localhost:7880"
    livekit_api_key: str = "devkey"
    livekit_api_secret: str = "devsecret-at-least-32-characters-long"

    max_upload_bytes: int = 100 * 1024 * 1024  # 100 MB
    password_min_length: int = 10

    seed_superadmin_email: str = "admin@rhythmrx.ai"
    seed_superadmin_password: str = ""

    @field_validator("secret_key")
    @classmethod
    def _no_default_secret_in_prod(cls, v: str, info):
        return v

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
