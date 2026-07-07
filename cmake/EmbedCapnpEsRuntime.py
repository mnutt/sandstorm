#!/usr/bin/env python3

import re
import sys
from pathlib import Path

output_path = Path(sys.argv[1])
manifest_path = Path(sys.argv[2])
runtime_root = Path(sys.argv[3]).resolve()

entries = []
for line in manifest_path.read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    module_name, runtime_path = line.split()
    entries.append((module_name, runtime_path))

import_re = re.compile(
    r"(?:import|export)\s+(?:[^'\"\n]*?\s+from\s+)?[\"']([^\"']+)[\"']")


def runtime_file(relative_path):
    path = (runtime_root / relative_path).resolve()
    path.relative_to(runtime_root)
    if path.suffix != ".mjs":
        raise ValueError(f"runtime module is not an .mjs file: {path}")
    return path


def module_name_for_path(path):
    relative = path.relative_to(runtime_root).as_posix()
    if relative.startswith("shared/"):
        return "@mnutt/shared/" + relative.removeprefix("shared/")
    if relative == "index.mjs":
        return "@mnutt/capnp-es"
    if relative.startswith("capnp/"):
        return "@mnutt/capnp-es/" + relative.removesuffix(".mjs")
    raise ValueError(f"unexpected runtime module path: {relative}")


records = []
queued = []
seen_aliases = set()
scanned_paths = set()


def add_record(module_name, path):
    if module_name not in seen_aliases:
        seen_aliases.add(module_name)
        records.append((module_name, path))
        queued.append(path)


for module_name, relative_path in entries:
    add_record(module_name, runtime_file(relative_path))

while queued:
    path = queued.pop(0)
    if path in scanned_paths:
        continue
    scanned_paths.add(path)
    source = path.read_text(encoding="utf-8")
    for match in import_re.finditer(source):
        specifier = match.group(1)
        if specifier.startswith("."):
            imported = runtime_file((path.parent / specifier).relative_to(runtime_root))
            add_record(module_name_for_path(imported), imported)


def escape(data):
    result = []
    for byte in data:
        if byte == 0x0A:
            result.append(r"\n")
        elif byte == 0x0D:
            result.append(r"\r")
        elif byte == 0x09:
            result.append(r"\t")
        elif byte == 0x22:
            result.append(r'\"')
        elif byte == 0x5C:
            result.append(r"\\")
        elif 0x20 <= byte <= 0x7E:
            result.append(chr(byte))
        else:
            result.append(f"\\x{byte:02x}")
    return "".join(result)


output_path.parent.mkdir(parents=True, exist_ok=True)
with output_path.open("w", encoding="utf-8") as output:
    output.write("// Generated from the pinned @mnutt/capnp-es npm package. Do not edit.\n")
    output.write("#pragma once\n\nnamespace sandstorm {\n\n")
    output.write("struct IsolateCapnpEsModuleSource { const char* name; const char* source; };\n\n")
    source_names = []
    for index, (_, path) in enumerate(records):
        source_name = f"ISOLATE_CAPNP_ES_SOURCE_{index}"
        source_names.append(source_name)
        output.write(f"static constexpr const char {source_name}[] =\n")
        data = path.read_bytes()
        for offset in range(0, len(data), 100):
            output.write(f'    "{escape(data[offset:offset + 100])}"\n')
        output.write("    ;\n\n")
    output.write("static constexpr IsolateCapnpEsModuleSource ISOLATE_CAPNP_ES_MODULES[] = {\n")
    for (module_name, _), source_name in zip(records, source_names):
        output.write(f'  {{ "{module_name}", {source_name} }},\n')
    output.write("};\n\n")
    output.write(f"static constexpr uint ISOLATE_CAPNP_ES_MODULE_COUNT = {len(records)};\n\n")
    output.write("}  // namespace sandstorm\n")
