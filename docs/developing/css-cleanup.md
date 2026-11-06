# Sandstorm Shell CSS Cleanup

The shell CSS cleanup is a focused migration project for moving Sandstorm away
from a single global Sass cascade and toward feature-owned styles with explicit
shared primitives.

## Goals

- Make stylesheet ownership obvious from file location.
- Reduce broad global selectors, styling IDs, `!important`, and `@extend`
  coupling.
- Preserve the current visual behavior while moving rules.
- Use the existing Meteor/Rspack/Sass stack instead of adding another CSS
  framework.
- Keep CSS Modules available for isolated JS-owned widgets, but do not require
  them for Blaze templates.

## Baseline

Run this from `shell/`:

```sh
npm run css:inventory
```

The initial inventory reported:

- 8,540 stylesheet lines.
- 1,360 detected selectors.
- 294 top-level selectors.
- 25 selectors containing `body`.
- 30 selectors containing IDs.
- 27 `!important` declarations.
- 255 `@extend` usages.

Highest-risk global files at the start of the project:

1. `client/styles/_account.scss`
2. `client/styles/_topbar.scss`
3. `client/styles/_admin-users.scss`
4. `client/styles/_shell-legacy-main.scss`
5. `client/styles/_setup-wizard.scss`

## Migration Order

Use this order unless a specific feature is already being edited:

1. Admin pages.
2. Setup wizard.
3. Grain list, app list, and app details.
4. Account, login, and billing flows.
5. Topbar, navbar, popups, and remaining shell frame styles.

Admin pages are first because they already have a sub-manifest and mostly use
bounded form/table UI. Topbar and account styles should wait until the migration
pattern is proven because they have the most global coupling.

## Per-Area Checklist

For each product area:

1. Capture or identify visual snapshot coverage for the main states.
2. Move the stylesheet beside the owning template/client module.
3. Import the stylesheet from that module.
4. Keep a clear root scope class around feature rules.
5. Replace incidental `@extend` usage with mixins or explicit classes when it is
   local to the migrated area.
6. Remove the old import from `client/styles/shell.scss` or its sub-manifest.
7. Run `npm run css:inventory` and confirm global risk is lower.
8. Run the relevant visual and functional tests.

## Local Rules

See `shell/client/styles/README.md` for the conventions that should govern new
and migrated styles.
