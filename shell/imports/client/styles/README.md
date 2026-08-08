# Sandstorm Shell CSS

This directory contains shared stylesheet infrastructure for the Sandstorm
shell. Feature-owned styles should be colocated with the Blaze templates and
client modules that render them.

## Current State

- `global/shell-ui.scss` is the shell-wide ordering-only manifest.
- Most existing styles compile as one global cascade through Rspack and Sass.
- Shared global CSS lives in `imports/client/styles/global`; Sass-only tokens,
  geometry values, icon mixins, and reusable mixins live in namespaced
  directories here.
- Shell frame styles that still emit global selectors now live under
  `imports/client/shell/styles`; grain frame and sharing styles live under
  `imports/client/grain/styles`.

## Target Shape

New and migrated styles should use this ownership model:

- Application-wide emitted defaults: keep in `imports/client/styles/global`, and
  load them from `global/shell-ui.scss`.
- Shared tokens and primitives: keep in `imports/client/styles/colors`,
  `imports/client/styles/geometry`, `imports/client/styles/mixins`, or
  `imports/client/styles/icons`, exposed with Sass `@use` or plain reusable
  classes. Larger reusable component mixins should live under their own module
  owner, such as `imports/client/grainlist/styles/primitives`. Do not put loose
  Sass API files directly under `imports/client/styles`.
- Shared color files should stay foundational. Put feature-specific palettes
  beside the styles that consume them.
- Shared geometry files should stay foundational. Put shell-frame dimensions
  under `imports/client/shell-frame/styles`.
- Shared mixins should stay foundational. Put reusable component mixins under an
  owning module such as `imports/client/search/styles` or
  `imports/client/login-provider/styles`.
- Feature styles: colocate under `imports/client/...` beside the owning
  template/client module, and import them from that module.
- Vendor CSS and narrow vendor overrides: keep near the application entrypoint
  unless the vendor is only used by one feature.
- Use `icons/api` for Sass-only icon mixins. `global/icons` should remain the
  single global source of the emitted icon font and `.icon-*` classes.

## Migration Rules

- Move styles by product area, not by selector type.
- Preserve visual behavior first; simplify selectors after screenshot coverage
  exists for the area.
- Every feature stylesheet should have one obvious root scope class, such as
  `.admin-users`, `.setup-root`, or `.grain-settings`.
- Do not add new broad selectors like `body > ...` unless styling the shell
  frame itself.
- Do not add IDs for styling.
- Avoid `!important`; if it is needed temporarily, leave a comment naming the
  conflicting rule.
- Prefer mixins or real classes over new Sass `%placeholder` selectors and
  broad `@extend` usage.
- Shared styles should graduate to primitives only after at least two real
  feature usages.
- Avoid relative Sass imports across owner directories; promote real cross-owner
  reuse into a named shared Sass API directory.
- Keep class names stable when JavaScript events, tests, or existing templates
  depend on them.

## CSS Modules

Meteor/Rspack supports CSS Modules, but Blaze templates make them awkward
because generated class names must be passed through helpers. Use CSS Modules
selectively for new JS-owned components or small isolated widgets. For migrated
Blaze UI, prefer colocated SCSS with a root scope class.

## Inventory

Run the stylesheet inventory from `shell/`:

```sh
npm run css:inventory
```

For machine-readable output:

```sh
npm run css:inventory -- --json
```

To enforce the current organization boundary:

```sh
npm run css:check
```

This check permits shared Sass APIs only in named directories here; feature
styles should be imported from their owning client module, and JS/TS stylesheet
imports must resolve to the owning module's `styles/` directory.

Use the inventory to choose migration order, identify broad selectors, and
verify that risk is going down as files move out of the global cascade. The
inventory scans shared styles here, migrated feature styles under
`imports/client`, and colocated `sandstorm-ui-*` package styles.
