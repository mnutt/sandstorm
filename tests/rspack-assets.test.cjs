const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

for (const isServer of [false, true]) {
  test(`Rspack preserves ${isServer ? 'private' : 'public'} assets under a build checkout`, () => {
    const module = { exports: {} };
    const directory = '/tmp/build/sandstorm/shell';
    const load = name => {
      if (name === '@meteorjs/rspack') return { defineConfig: value => value };
      if (name === '@rspack/core') return { IgnorePlugin: class {} };
      return require(name);
    };
    load.resolve = name => name;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../shell/rspack.config.js'), 'utf8'),
      { module, require: load, __dirname: directory });
    const keep = module.exports({ isServer }).output.clean.keep;
    const root = path.join(directory, isServer ? 'private' : 'public');
    for (const name of ['icons/icons-test.woff2', 'fonts/SourceSansPro.woff',
      'appmarket.svg', 'checkout.html', 'sandstorm-purplecircle.png']) {
      assert.equal(keep(name), true);
      assert.equal(keep(path.join(root, name)), true);
    }
    for (const name of ['build/main.js', 'build-chunks/old.js', 'build-assets/old.css']) {
      assert.equal(keep(name), false);
      assert.equal(keep(path.join(root, name)), false);
    }
  });
}
