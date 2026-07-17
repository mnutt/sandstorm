#!/usr/bin/env python3

import json
import pathlib
import sys


def escape(source: bytes) -> str:
    return "".join(f"\\x{byte:02x}" for byte in source)


if len(sys.argv) != 5:
    raise SystemExit("usage: EmbedIsolateApi.py API BROWSER VALIDATION OUTPUT")

api_path, browser_path, validation_path, output_path = map(pathlib.Path, sys.argv[1:])
api_source = api_path.read_bytes()
browser_source = browser_path.read_text(encoding="utf-8")
validation_source = validation_path.read_bytes()

marker = b'"__SANDSTORM_BROWSER_CLIENT_SOURCE__"'
replacement = json.dumps(browser_source, ensure_ascii=True).encode("ascii")
if api_source.count(marker) != 1:
    raise RuntimeError("api.js browser client source marker must occur exactly once")
api_source = api_source.replace(marker, replacement)

output_path.parent.mkdir(parents=True, exist_ok=True)
output_path.write_text(
    "// Generated from isolate JavaScript sources. Do not edit.\n"
    "#pragma once\n\n"
    "namespace sandstorm {\n"
    f'static constexpr const char ISOLATE_API_HELPER_SOURCE[] = "{escape(api_source)}";\n'
    f'static constexpr const char ISOLATE_VALIDATION_HELPER_SOURCE[] = "{escape(validation_source)}";\n'
    "}  // namespace sandstorm\n",
    encoding="utf-8",
)
