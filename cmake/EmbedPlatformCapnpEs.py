#!/usr/bin/env python3

import json
import os
import pathlib
import subprocess
import sys


def escape(data: bytes) -> str:
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


if len(sys.argv) != 7:
    raise SystemExit(
        "usage: EmbedPlatformCapnpEs.py OUTPUT MANIFEST NODE CAPNP COMPILER SOURCE_ROOT")

output_path = pathlib.Path(sys.argv[1])
manifest_path = pathlib.Path(sys.argv[2])
node = sys.argv[3]
capnp = sys.argv[4]
compiler_module = pathlib.Path(sys.argv[5]).resolve()
source_root = pathlib.Path(sys.argv[6]).resolve()

schema_specs = []
for line in manifest_path.read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    if not line.startswith("sandstorm/") or not line.endswith(".capnp"):
        raise ValueError(f"expected a sandstorm/*.capnp schema path in {manifest_path}: {line}")
    schema_specs.append(line)
if not schema_specs:
    raise ValueError(f"no platform schemas listed in {manifest_path}")

extra_includes = [
    include for include in os.environ.get("CAPNP_ES_EXTRA_INCLUDE", "").split(":") if include
]
capnpc = subprocess.run(
    [capnp, "compile", "-o-", *[f"-I{include}" for include in extra_includes],
     "-I.", "-I/usr/include", *schema_specs],
    cwd=source_root,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    check=False,
)
if capnpc.returncode != 0:
    sys.stderr.write(capnpc.stderr.decode("utf-8", errors="replace"))
    raise SystemExit(capnpc.returncode)

node_script = r"""
import path from 'node:path';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { compileAll } = await import(process.argv[1]);

function runtimeModuleSpecifier(moduleName) {
  if (moduleName === '@mnutt/capnp-es') return '/capnp-es/index.mjs';
  if (moduleName.startsWith('@mnutt/capnp-es/')) {
    const relative = moduleName.slice('@mnutt/capnp-es/'.length);
    return '/capnp-es/' + relative + (relative.endsWith('.mjs') ? '' : '.mjs');
  }
  if (moduleName.startsWith('@mnutt/shared/')) {
    return '/capnp-es/shared/' + moduleName.slice('@mnutt/shared/'.length);
  }
  if (moduleName.startsWith('@mnutt/')) {
    return '/capnp-es/' + moduleName.slice('@mnutt/'.length);
  }
  return moduleName;
}

function relativeSchemaSpecifier(fromPath, toPath) {
  const from = fromPath.replace(/\.ts$/, '.capnp');
  const to = toPath.replace(/\.ts$/, '.capnp');
  let relative = path.posix.relative(path.posix.dirname(from), to);
  if (relative === '') relative = '.';
  if (!relative.startsWith('.')) relative = './' + relative;
  return relative;
}

const { files } = await compileAll(Buffer.concat(chunks), {
  js: true,
  tsconfig: { noCheck: true },
  moduleSpecifier(context) {
    if (context.kind === 'runtime') return runtimeModuleSpecifier(context.originalSpecifier);
    return relativeSchemaSpecifier(context.fromPath, context.toPath);
  }
});
process.stdout.write(JSON.stringify([...files.entries()]));
"""

compiled = subprocess.run(
    [node, "--input-type=module", "-e", node_script, str(compiler_module)],
    input=capnpc.stdout,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    check=False,
)
if compiled.returncode != 0:
    sys.stderr.write(compiled.stderr.decode("utf-8", errors="replace"))
    raise SystemExit(compiled.returncode)
generated_files = dict(json.loads(compiled.stdout.decode("utf-8")))

records = []
for schema in schema_specs:
    generated_path = schema.removesuffix(".capnp") + ".js"
    if generated_path not in generated_files:
        raise RuntimeError(
            f"capnp-es compiler did not emit {generated_path}; emitted: "
            + ", ".join(sorted(generated_files)))
    records.append((
        "capnp:/" + schema,
        "capnp-es-generated/" + generated_path,
        generated_files[generated_path].encode("utf-8"),
    ))

output_path.parent.mkdir(parents=True, exist_ok=True)
with output_path.open("w", encoding="utf-8") as output:
    output.write("// Generated from Sandstorm platform schemas with capnp-es. Do not edit.\n")
    output.write("#pragma once\n\nnamespace sandstorm {\n\n")
    output.write("struct IsolatePlatformCapnpEsModuleSource {\n")
    output.write("  const char* name;\n  const char* runtimePath;\n  const char* source;\n};\n\n")
    source_names = []
    for index, (_, _, source) in enumerate(records):
        source_name = f"ISOLATE_PLATFORM_CAPNP_ES_SOURCE_{index}"
        source_names.append(source_name)
        output.write(f"static constexpr const char {source_name}[] =\n")
        for offset in range(0, len(source), 100):
            output.write(f'    "{escape(source[offset:offset + 100])}"\n')
        output.write("    ;\n\n")
    output.write(
        "static constexpr IsolatePlatformCapnpEsModuleSource "
        "ISOLATE_PLATFORM_CAPNP_ES_MODULES[] = {\n")
    for (name, runtime_path, _), source_name in zip(records, source_names):
        output.write(f'  {{ "{name}", "{runtime_path}", {source_name} }},\n')
    output.write("};\n\n")
    output.write(
        f"static constexpr uint ISOLATE_PLATFORM_CAPNP_ES_MODULE_COUNT = {len(records)};\n\n")
    output.write("}  // namespace sandstorm\n")
