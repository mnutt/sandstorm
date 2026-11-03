# Deferred ApiSession enhancements

The pending ApiSession enhancements have been removed from the active outbound work
so they can be reviewed and committed separately later. ApiSession's schema,
external driver and credential validation are restored to this branch's committed
baseline, `f6740e8d7`. Earlier committed ApiSession work has not been rewritten.

The complete pre-split working state, including untracked implementation and tests,
is preserved in the local branch `wip/api-session-before-outbound-split`, commit
`fa6754ce353bfd4b973695327b8dab20b1826a77`. This is a recovery snapshot of all the HTTP
work, not an isolated ApiSession commit. It excludes the unrelated `deps/workerd/`
checkout. The normal staging index was left unchanged.

Deferred changes include:

- ApiSession authentication declarations, method attenuation and experimental fields.
- ApiSession's dependency on the outbound driver base and new live revocation checks.
- Named-header/raw/scheme authentication, caller mode, PATCH and broader request headers.
- ApiSession-specific settings encryption and migration.
- Associated schema, persistence, Powerbox and driver tests.

OutboundHttpSession now owns its authentication declaration type and has its own
credential form and validation module. The moved schema types retain their experimental
type IDs and field ordinals. Existing ApiSession form/profile behavior remains separate.
The low-level transport was already used by both drivers before this split and remains
shared; consolidating their driver implementations is deferred.

Validation after the split: 96 standalone tests passed, the native schema/probe build
passed, and both isolated browser tests passed (five assertions) against a fresh fast
bundle. These cover the legacy outbound regression and the separate managed outbound
form, encrypted storage, restoration and revocation. Targeted lint had no errors.

To resume, inspect the saved branch or create a worktree from it. Port the ApiSession
changes onto the then-current outbound branch and commit them separately. Do not blindly
apply the entire snapshot: it also contains outbound work and the earlier schema location.
