# Shell UI foundation

Bits UI 2.21.0 supplies headless interaction primitives. These wrappers own
Sandstorm presentation; pages compose them rather than importing Bits directly.
Use Svelte scoped CSS, with plain semantic tokens and no utility-CSS dependency.

## Ownership

- `src/styles.css`: `--ss-*` tokens, document box sizing/body reset, `.sr-only`.
  No global button, input, list, section, heading, or Bits data-attribute selectors.
- `Button.svelte`: Bits button, primary/secondary/danger variants, focus/disabled
  states. Defaults to `type="button"`; form actions must explicitly use `submit`.
  A local wrapper scopes the narrow `:global()` selectors needed to style the
  DOM rendered by Bits. Don't add global `.button` rules.
- `TextInput.svelte` and `NativeSelect.svelte`: native semantics and bindable
  values, styled once. Keep labels/help text with the page. Use `aria-describedby`
  for help and `aria-invalid` for validation failures. Use a Bits Select only
  when richer behavior is needed; simple selects should retain native behavior.
- `Panel.svelte`: section surface, responsive padding and border. Pass accessible
  section labels through its HTML props; typography stays with the content owner.
- `Modal.svelte`: Bits Dialog owns focus, Escape, scroll locking, outside clicks,
  and trigger restoration. Title/description are required. Its child snippets
  render native nodes so the portal's CSS remains Svelte-scoped. Set `busy` while
  a write is pending and provide an explicit close/cancel action in the content.
- Page components: local layout, headings, labels, list rows and empty states.
  Never reach through component boundaries to override a control's internals.

## Visual direction

Retain Sandstorm's purple identity (`#6e3c8e` with a darker active/hover shade),
clear navigation, and content-first layouts. Use lightly tinted neutral canvas,
white panels, restrained rounding/shadows, and system fonts. Keep the application
iframe visually distinct from shell chrome. No remote fonts or decorative assets.

Use semantic tokens for color, spacing, radii, typography, focus and overlay
stacking. Tokens live on `:root` so portals under `body` inherit them. A future
alternate theme should override tokens there (or on an explicit portal container),
not require page-specific overrides. Light mode is the current supported theme.

Controls have a 44px minimum target height. Focus uses a visible 3px outline;
selected navigation has a border/inset marker as well as color. The current
foundation uses no motion; future transitions must honor reduced-motion settings.
Preserve native links and browser modifiers for route navigation. Shell placement follows the main UI: Apps/Grains in the left rail, notifications
and the account popover in the top bar, and grain actions immediately above the
iframe. Explanatory preview copy stays out of the workspace. Panels use compact
padding; desktop grain rows align their metadata in columns. At narrow widths
the rail becomes a short horizontal navigation row and actions wrap. Keep component content usable
at zoom and allow long account/grain names to wrap.

## Validation

`make -C rust-shell test` checks TypeScript/Svelte and browser interactions.
The browser suite exercises dialog focus trapping/restoration, Escape, form saves,
portal styling, mobile overflow, and absence of style leakage into unrelated DOM.
Review desktop, mobile, and dialog captures in `/tmp/sandstorm-rust-ui-*.png`
after running tests. The trusted offer-template document has its own stylesheet;
it does not inherit shell or app-frame styles.

Official API references:
- https://bits-ui.com/docs/components/button
- https://bits-ui.com/docs/components/dialog
