from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application config loaded from env vars / .env."""

    database_url: str
    port: int = 8001
    log_level: str = "info"
    prophet_changepoint_prior_scale: float = 0.05
    prophet_seasonality_prior_scale: float = 10.0
    min_samples_for_fit: int = 48  # 2 days of hourly data

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


def load_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
