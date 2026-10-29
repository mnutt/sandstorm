import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

for (const mode of ["success", "failure", "missing"]) {
  test(`schema generation: ${mode}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "capnp-generation-"));
    try {
      fs.mkdirSync(path.join(root, "tools"));
      fs.copyFileSync(new URL("../generate-capnp-es-schemas.mjs", import.meta.url),
        path.join(root, "tools/generate-capnp-es-schemas.mjs"));
      fs.mkdirSync(path.join(root, "src/sandstorm"), { recursive: true });
      fs.writeFileSync(path.join(root, "src/sandstorm/test.capnp"), "@0xe9f285cb3e122a77; struct Test { value @0 :Text; }\n");
      const output = path.join(root, "shell/imports/server/capnp-es/generated");
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, "previous.ts"), "previous bindings\n");
      const compiler = path.join(root, "compiler.mjs");
      if (mode !== "missing") {
        fs.writeFileSync(compiler, `#!/usr/bin/env node
          import fs from "node:fs";
          const output = process.cwd();
          fs.writeFileSync(output + "/next.ts", 'import { X } from "./x.js";\\n');
          process.exit(${mode === "failure" ? 1 : 0});
        `, { mode: 0o755 });
      }
      const result = spawnSync(process.execPath,
        [path.join(root, "tools/generate-capnp-es-schemas.mjs")], {
          encoding: "utf8", env: { ...process.env, CAPNP_ES_COMPILER: compiler },
        });
      assert.ifError(result.error);
      if (mode === "success") {
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(fs.readdirSync(output), ["next.ts"]);
        assert.equal(fs.readFileSync(path.join(output, "next.ts"), "utf8"),
          '// @ts-nocheck\nimport { X } from "./x";\n');
      } else {
        assert.notEqual(result.status, 0);
        assert.deepEqual(fs.readdirSync(output), ["previous.ts"]);
        assert.equal(fs.readFileSync(path.join(output, "previous.ts"), "utf8"),
          "previous bindings\n");
      }
      assert.deepEqual(fs.readdirSync(path.dirname(output)), ["generated"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
