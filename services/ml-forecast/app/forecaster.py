"""
Forecaster: Prophet primary, naive seasonal fallback when sample count is too low.

Returns a structured forecast with prediction intervals plus a backtest MAPE
when there are enough historical points to hold out a tail.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import numpy as np
import pandas as pd

try:
    from prophet import Prophet
    HAS_PROPHET = True
except ImportError:  # pragma: no cover
    HAS_PROPHET = False


@dataclass(slots=True)
class ForecastPoint:
    date: str
    predicted: float
    ci_lower: float
    ci_upper: float


@dataclass(slots=True)
class ForecastResult:
    model: str
    points: list[ForecastPoint]
    mape: float | None
    samples: int


def _to_frame(history: list[dict[str, Any]]) -> pd.DataFrame:
    if not history:
        return pd.DataFrame(columns=["ds", "y"])
    df = pd.DataFrame(history)
    df["ds"] = pd.to_datetime(df["bucket"], utc=True).dt.tz_localize(None)
    df["y"] = df["score"].astype(float)
    return df[["ds", "y"]].dropna()


def _mape(actual: np.ndarray, predicted: np.ndarray) -> float | None:
    mask = actual != 0
    if not mask.any():
        return None
    return float(np.mean(np.abs((actual[mask] - predicted[mask]) / actual[mask])) * 100.0)


def fit_prophet(
    history: list[dict[str, Any]],
    horizon_days: int,
    *,
    changepoint_prior_scale: float = 0.05,
    seasonality_prior_scale: float = 10.0,
) -> ForecastResult:
    df = _to_frame(history)
    samples = len(df)

    if samples < 48 or not HAS_PROPHET:
        return _naive_seasonal_forecast(df, horizon_days, samples)

    # Hold out last 7 days for backtest if we have enough data.
    backtest_hours = 24 * 7
    do_backtest = samples > backtest_hours + 24

    train_df = df.iloc[:-backtest_hours] if do_backtest else df
    test_df = df.iloc[-backtest_hours:] if do_backtest else None

    model = Prophet(
        changepoint_prior_scale=changepoint_prior_scale,
        seasonality_prior_scale=seasonality_prior_scale,
        daily_seasonality=True,
        weekly_seasonality=True,
        yearly_seasonality=False,
        interval_width=0.9,
    )
    model.fit(train_df)

    mape: float | None = None
    if do_backtest and test_df is not None and not test_df.empty:
        future_test = pd.DataFrame({"ds": test_df["ds"]})
        pred_test = model.predict(future_test)
        mape = _mape(test_df["y"].to_numpy(), pred_test["yhat"].to_numpy())

    # Refit on full history for the actual forecast.
    final_model = Prophet(
        changepoint_prior_scale=changepoint_prior_scale,
        seasonality_prior_scale=seasonality_prior_scale,
        daily_seasonality=True,
        weekly_seasonality=True,
        yearly_seasonality=False,
        interval_width=0.9,
    )
    final_model.fit(df)
    future = final_model.make_future_dataframe(periods=horizon_days, freq="D", include_history=False)
    forecast = final_model.predict(future)

    points = [
        ForecastPoint(
            date=row["ds"].strftime("%Y-%m-%d"),
            predicted=float(row["yhat"]),
            ci_lower=float(row["yhat_lower"]),
            ci_upper=float(row["yhat_upper"]),
        )
        for _, row in forecast.iterrows()
    ]
    return ForecastResult(model="prophet-v1", points=points, mape=mape, samples=samples)


def _naive_seasonal_forecast(
    df: pd.DataFrame, horizon_days: int, samples: int
) -> ForecastResult:
    """Fallback: last-known mean ± 1 std, holding flat. Used when data is thin."""
    if df.empty:
        base = 50.0
        std = 5.0
    else:
        base = float(df["y"].tail(48).mean())
        std = float(df["y"].tail(48).std() or 5.0)
    points: list[ForecastPoint] = []
    start = datetime.now(timezone.utc).replace(microsecond=0, second=0, minute=0)
    for d in range(1, horizon_days + 1):
        date = start + pd.Timedelta(days=d)
        points.append(
            ForecastPoint(
                date=date.strftime("%Y-%m-%d"),
                predicted=base,
                ci_lower=base - 1.65 * std,
                ci_upper=base + 1.65 * std,
            )
        )
    return ForecastResult(model="naive-seasonal-v1", points=points, mape=None, samples=samples)
