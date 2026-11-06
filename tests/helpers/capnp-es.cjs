// Load the shell's real capnp-es adapter and generated TypeScript without Meteor.
// Requires Node 24 (the shell runtime); no native binding or source rewriting is used.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { registerHooks, stripTypeScriptTypes } = require('node:module');
const root = path.resolve(__dirname, '../..');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier, context.parentURL);
      if (!path.extname(url.pathname) && fs.existsSync(fileURLToPath(url) + '.ts')) {
        return { url: url.href + '.ts', shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.ts')) {
      return { format: 'module', shortCircuit: true,
        source: stripTypeScriptTypes(fs.readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform' }) };
    }
    return nextLoad(url, context);
  },
});
module.exports = require(path.join(root, 'shell/imports/server/capnp.js')).default;
