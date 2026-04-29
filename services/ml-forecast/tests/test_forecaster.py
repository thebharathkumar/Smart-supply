"""Forecaster tests that don't require Prophet to be installed.

The naive_seasonal fallback runs whenever sample count is < 48 or Prophet
import fails - both paths exercised here.
"""
from __future__ import annotations

import datetime as dt
from unittest.mock import patch


from app import forecaster as fc


def _hourly_history(hours: int, start_score: float = 50.0) -> list[dict]:
    base = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    return [
        {
            "bucket": base + dt.timedelta(hours=h),
            "score": start_score + (h % 24) * 0.5,
        }
        for h in range(hours)
    ]


def test_empty_history_uses_naive_fallback():
    res = fc.fit_prophet([], horizon_days=7)
    assert res.model == "naive-seasonal-v1"
    assert len(res.points) == 7
    assert res.mape is None


def test_thin_history_uses_naive_fallback():
    res = fc.fit_prophet(_hourly_history(20), horizon_days=14)
    assert res.model == "naive-seasonal-v1"
    assert len(res.points) == 14


def test_naive_fallback_when_prophet_unavailable():
    # Even with plenty of data, pretend Prophet isn't importable.
    history = _hourly_history(200)
    with patch.object(fc, "HAS_PROPHET", False):
        res = fc.fit_prophet(history, horizon_days=10)
    assert res.model == "naive-seasonal-v1"
    assert len(res.points) == 10
    # Predicted should be near recent mean.
    avg = sum(p["score"] for p in history[-48:]) / 48
    assert abs(res.points[0].predicted - avg) < 5
    # CI bounds make sense.
    assert res.points[0].ci_lower < res.points[0].predicted < res.points[0].ci_upper


def test_to_frame_handles_empty():
    df = fc._to_frame([])
    assert df.empty


def test_mape_returns_none_when_all_zero():
    import numpy as np
    assert fc._mape(np.array([0.0, 0.0]), np.array([1.0, 2.0])) is None


def test_mape_computes_pct():
    import numpy as np
    actual = np.array([100.0, 100.0])
    pred = np.array([110.0, 90.0])
    res = fc._mape(actual, pred)
    assert res is not None
    assert abs(res - 10.0) < 0.1
