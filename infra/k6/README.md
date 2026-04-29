# Load tests

```bash
# After bringing the stack up + seeding:
docker compose -f infra/docker-compose.yml up -d

# REST baseline (suppliers, routes, hubs)
k6 run -e BASE_URL=http://localhost:4000 infra/k6/rest-baseline.js

# NSGA-II optimization endpoint
k6 run -e BASE_URL=http://localhost:4000 infra/k6/optimize-load.js

# Prophet forecast (cache + cold)
k6 run -e BASE_URL=http://localhost:4000 infra/k6/forecast-load.js

# WebSocket end-to-end fanout latency
k6 run -e BASE_URL=ws://localhost:4000 infra/k6/ws-fanout.js
```

Each script asserts the SLO thresholds documented in the top-of-file comment.

If you don't have k6 locally:

```bash
# macOS
brew install k6

# Linux
sudo apt install k6   # or download from https://k6.io
```

The thresholds in the README are the targets; actual numbers depend on host
and observability overlay. Capture summaries with `--summary-export=run.json`
and commit the JSON snapshot under `infra/k6/results/` for regression
tracking.
