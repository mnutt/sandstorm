# Sandstorm Shell CSS

This directory is the legacy global stylesheet entrypoint for the Sandstorm
shell. The cleanup project should move it toward a small compatibility layer,
with feature-owned styles colocated with the Blaze templates and client modules
that render them.

## Current State

- `shell.scss` is an ordering-only manifest. Keep its order stable while moving
  rules out of it.
- Most existing styles compile as one global cascade through Rspack and Sass.
- `_colors.scss`, `_geometry.scss`, `_partials.scss`, `_icons.scss`, and
  `_focus.scss` are shared infrastructure, but they still contain legacy
  patterns that should be tightened during migration.
- Shell frame styles that still emit global selectors now live under
  `imports/client/shell/styles`; grain frame and sharing styles live under
  `imports/client/grain/styles`.

## Target Shape

New and migrated styles should use this ownership model:

- Application-wide defaults: keep in `client/styles`.
- Shared tokens and primitives: keep in `client/styles`, exposed with Sass
  `@use` or plain reusable classes.
- Feature styles: colocate under `imports/client/...` beside the owning
  template/client module, and import them from that module.
- Vendor CSS and narrow vendor overrides: keep near the application entrypoint
  unless the vendor is only used by one feature.

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

Use the inventory to choose migration order, identify broad selectors, and
verify that risk is going down as files move out of the global cascade. The
inventory scans this legacy directory, migrated feature styles under
`imports/client`, and colocated `sandstorm-ui-*` package styles.
