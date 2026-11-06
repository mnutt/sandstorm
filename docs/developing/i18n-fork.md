# Bringing tap i18n back into Sandstorm

Sandstorm should evaluate a pinned current upstream revision of `tap:i18n` on
Meteor 3.5.1, then maintain a small fork only for demonstrated compatibility gaps.
Keep `/imports/tapi18n` as the application boundary so translation callers do not
depend on the fork's packaging. Restore established translation behavior without
combining the work with a translation catalog rewrite or an i18next major upgrade.

These are implementation notes, not a completed compatibility assessment.

## Starting point

Commit `bea1b69da` (`upgrade to meteor 3`) removed `tap:i18n@1.12.4` and replaced
the re-export in `shell/imports/tapi18n.js` with a small implementation. It bundles
seven JSON catalogs and implements lookup, English fallback, interpolation, and
a Blaze helper. Language changes are synchronous and do not invalidate Tracker
computations; `.done()` and `.fail()` are compatibility stubs.

The source project is [TAPevents/tap-i18n](https://github.com/TAPevents/tap-i18n).
The upstream manifest inspected on October 21, 2026 declares version 2.3.1,
CoffeeScript and several Meteor package dependencies, a translation compiler,
and browser/server tests. Its Meteor version baseline alone does not establish
whether it works on our release. Resolve and record an exact commit before
starting; do not base the fork automatically on our old 1.12.4 dependency.
See [upstream package.js](https://github.com/TAPevents/tap-i18n/blob/master/package.js).

## Application behavior to preserve

- Keep all seven catalogs: English, Finnish, French, Dutch, Russian, Simplified
  Chinese, and Traditional Chinese. Preserve nested keys and UTF-8 text.
- Preserve English fallback and missing-key output. Keep `%s` positional
  substitutions and `__name__` named substitutions, including `count` and `quota`.
- Preserve JavaScript calls such as `__(key, grainTitle)` as well as options
  objects. Verify the upstream argument contract and adapt positional arguments
  to its `sprintf` option at our wrapper if needed.
- Preserve `{{_ ...}}` in templates, including hash arguments and wrapped keys.
  Our wrapper currently uses `coerceTemplateText` from
  `shell/imports/shared/template-values.js`; upstream's helper must be tested
  against these actual Blaze values before removing that normalization.
- Keep `getLanguages()` usable by the browser-language selection in
  `shell/imports/client/shell-client.js`. Preserve exact Chinese dialect choices
  and French regional fallback, and test case normalization explicitly.
- Give startup a real completion/failure contract. Existing startup uses
  `setLanguage(...).done(...).fail(...)`; either preserve it or deliberately
  convert that caller and its declarations together.

The current catalogs contain `__count__` substitutions but a search found no
`_plural` keys. Restoring plural rules provides a capability we should test; it
does not by itself correct existing translated prose. Catalog improvements are
a separate task. Likewise, language selection currently happens at startup;
reactivity matters for asynchronous initialization and future changes without
implying there is already a user-facing language switcher.

## Work needed in the fork

1. **Establish a reproducible baseline.** Run upstream's tests and a minimal
   fixture on Meteor 3.5.1, then integrate it into a Sandstorm development build.
   Record dependency-resolution, compiler, startup, and rendering failures
   separately. Save the upstream SHA, package version, license notices, and
   commands needed to reproduce each failure.
2. **Fix demonstrated Meteor compatibility issues.** Audit CoffeeScript output,
   package initialization order, exported globals, compiler dependencies, and
   any Fiber-dependent code in the selected revision and its dependencies.
   Check HTTP middleware under the actual Meteor runtime. Do not assume the
   entire package needs an async rewrite: catalog lookups should remain
   synchronous once resources are loaded.
3. **Preserve compiler behavior.** Verify discovery of our existing
   `shell/i18n/*.i18n.json` files, generated code ordering, rebuilds after a catalog
   edit, and production bundling. Avoid registering translations twice through
   both JSON imports and compiler output. Upstream's compiler embeds English
   and emits non-English server resources; test both targets.
   See the [translation compiler](https://github.com/TAPevents/tap-i18n/blob/master/lib/plugin/compilers/i18n.generic_compiler.coffee).
4. **Integrate the Blaze helper.** Decide whether key normalization belongs in a
   small upstream-compatible patch or in Sandstorm's adapter. Register `_` once.
   Keep string guards and test wrapped arrays, missing keys, and object-valued
   catalog entries. Verify interpolation and escaping where translations contain
   HTML and where substitutions contain user-controlled names.
5. **Restore reactive language state.** Upstream already has Tracker dependencies,
   asynchronous loading, and protection against an older language selection
   winning a race. Preserve those mechanisms and test them rather than replacing
   them with global mutable state. Verify normalization and dependency-language
   loading against our catalogs.
   See the [client implementation](https://github.com/TAPevents/tap-i18n/blob/master/lib/tap_i18n/tap_i18n-client.coffee).
6. **Choose and verify catalog delivery.** Start with upstream's same-origin
   translation routes. Test them through Sandstorm's actual routing and production
   bundle, including cache behavior. If loading fails, clear the loading indicator
   and leave a usable English UI; the current failure callback only logs.
   Preloading all seven catalogs remains an option if measurements justify it,
   but should preserve the same completion and reactive semantics.
   See the [server routes](https://github.com/TAPevents/tap-i18n/blob/master/lib/tap_i18n/tap_i18n-server.coffee).
7. **Keep the translation engine migration separate.** Upstream documents legacy
   i18next behavior, including count/context keys. First preserve that contract.
   A newer engine requires its own catalog-format, plural-rule, interpolation,
   fallback, and escaping assessment. Inspect the actual bundled engine before
   choosing an upgrade target.
   See the [upstream API documentation](https://github.com/TAPevents/tap-i18n/blob/master/README.md).

## Sandstorm integration

Use a pinned local Meteor package during development. For the maintained fork,
choose either checked-in package sources or an explicitly versioned published
package; production builds must not depend on a developer's external checkout.
If renaming the Meteor package, audit internal package references and tests too.

Replace the implementation in `shell/imports/tapi18n.js` with a thin adapter,
keeping application import paths stable. Update `tapi18n.d.ts` to describe the
actual arguments and asynchronous return value. Remove the adapter's static
catalog imports and helper registration once the fork owns those responsibilities.
Update `.meteor/packages` and `.meteor/versions` together.

Keep general compatibility fixes separate from Sandstorm-specific argument or
template adaptations, making useful patches straightforward to offer upstream.
Publishing a package or sending upstream changes is a later implementation step.

## Acceptance checks

Extend `tests/tests/i18n.js` and its browser hook in
`shell/imports/client/testing.js`. The current test assumes `setLanguage()` is
synchronous; change it to wait for actual language readiness before assertions.

- Retain current lookup, missing-key, positional/named substitution, French
  fallback, and wrapped-key regression cases.
- Exercise all seven catalogs, missing localized entries, unsupported tags,
  regional/case variants, and distinct `zh-CN`/`zh-TW` results.
- Mount a translated Blaze view, change language, and assert that rendered text
  updates without remounting. Also verify Tracker invalidation directly.
- Test delayed loads, failed loads and retry, and rapid successive language
  selections. Assert startup exits the loading state on success and failure.
- Use fixture catalogs for plural/context behavior, including Russian counts
  such as 1, 2, 5, 11, and 21. Do not modify production strings just to test rules.
- Verify literal text and intended markup with substitutions containing `<`, `&`,
  quotes, and HTML-like user names at real rendering call sites.
- Check development rebuilds and production routes/bundles. If server translation
  is used, test concurrent translations with explicit languages to avoid
  cross-request language leakage.

The first deliverable should be a compatibility result and a bounded patch list.
The migration is complete when those patches, the thin adapter, upstream tests,
and Sandstorm's browser/build checks all pass. If current upstream already meets
the requirements, use that pinned release and avoid carrying an unnecessary fork.
