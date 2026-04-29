import os
import sys

# Ensure tests can import the `app` package without installing.
HERE = os.path.dirname(__file__)
ROOT = os.path.abspath(os.path.join(HERE, ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

# Telemetry would try to talk to Jaeger; disable for tests.
os.environ.setdefault("OTEL_DISABLED", "true")
