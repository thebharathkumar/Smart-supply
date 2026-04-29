import os
import sys

HERE = os.path.dirname(__file__)
ROOT = os.path.abspath(os.path.join(HERE, ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

os.environ.setdefault("OTEL_DISABLED", "true")
# Force deterministic agent path - no Anthropic key in tests.
os.environ.pop("ANTHROPIC_API_KEY", None)
