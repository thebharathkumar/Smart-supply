#!/usr/bin/env python3
"""
Generate Pydantic v2 models from JSON Schema files exported by the
`@smart-supply/shared-types` package.

Reads:    packages/shared-types/schemas/*.json
Writes:   services/<svc>/app/generated_types.py

Each Python service imports from `app.generated_types` so a contract
change in the Zod source propagates with one `make codegen` away from
breaking compile.

Requires: pip install datamodel-code-generator
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIR = REPO_ROOT / "packages" / "shared-types" / "schemas"
SERVICES = ["ml-forecast", "ml-optimize", "ml-agent"]


def ensure_codegen_available() -> None:
    if shutil.which("datamodel-codegen") is None:
        sys.stderr.write(
            "datamodel-codegen not found.\n"
            "Install with: pip install datamodel-code-generator\n"
        )
        sys.exit(1)


def gen_for_service(svc: str) -> Path:
    """Generate a single combined module per service from all schemas."""
    out = REPO_ROOT / "services" / svc / "app" / "generated_types.py"
    out.parent.mkdir(parents=True, exist_ok=True)

    # datamodel-codegen accepts a directory of JSON Schema files in
    # JSONSchema mode and emits one Python module with all classes.
    args = [
        "datamodel-codegen",
        "--input",
        str(SCHEMA_DIR),
        "--input-file-type",
        "jsonschema",
        "--output",
        str(out),
        "--output-model-type",
        "pydantic_v2.BaseModel",
        "--target-python-version",
        "3.11",
        "--use-standard-collections",
        "--use-union-operator",
        "--use-schema-description",
        "--snake-case-field",
        "--disable-timestamp",
    ]
    print(f"[codegen] {svc}: {' '.join(args)}")
    subprocess.run(args, check=True)

    # Add a header so the file is obviously generated.
    body = out.read_text()
    out.write_text(
        '"""AUTO-GENERATED from packages/shared-types - do not edit by hand."""\n'
        "# Regenerate: pnpm --filter @smart-supply/shared-types export-schema && \\\n"
        "#             python services/scripts/generate_pydantic.py\n\n" + body
    )
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--service", help="Generate for a single service only")
    args = parser.parse_args()

    if not SCHEMA_DIR.is_dir():
        sys.stderr.write(
            f"{SCHEMA_DIR} does not exist. Run "
            "`pnpm --filter @smart-supply/shared-types export-schema` first.\n"
        )
        return 1

    ensure_codegen_available()
    targets = [args.service] if args.service else SERVICES
    for svc in targets:
        if svc not in SERVICES:
            sys.stderr.write(f"unknown service: {svc}\n")
            return 1
        path = gen_for_service(svc)
        print(f"[codegen] -> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
