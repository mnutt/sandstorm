# Sandstorm branch inventory

Snapshot of locally available refs on October 5, 2026. All 154 non-symbolic branch refs are included. Remote-tracking refs were not fetched. Exact ancestry records commit containment, not patch equivalence, release status, or authorship of an entire branch. Tip author and subject describe only the final commit. Shared tips and rebased histories are intentionally visible.

[Workstream catalogue](sandstorm-work-catalogue.md)

## Local branches

| Ref | Tip and date | Tip author | Exact containment | Tip subject |
| --- | --- | --- | --- | --- |
| `allow-web-workers` | `f896c30c0` 2026-03-07 | Michael Nutt | Separate from all three | relax csp to allow web workers; disable service workers by not loading them |
| `app-creation-powerbox` | `03e28f425` 2026-08-23 | Michael Nutt | HEAD | Fix isolate browser Cap'n Proto RPC |
| `apparmor-profile` | `5a3021ad6` 2026-04-22 | Michael Nutt | origin/dev, HEAD | installer adds apparmor profile on ubuntu 24.04 |
| `capnp-es` | `8d052ea59` 2026-05-20 | Michael Nutt | Separate from all three | add profiling and some performance optimizations |
| `ci-apt-get` | `645fdc70d` 2026-05-09 | Michael Nutt | origin/dev, HEAD | ensure update is always run before apt-get |
| `cmake` | `c0f44bb3a` 2026-08-08 | Michael Nutt | HEAD | stop meteor npm rebuild from using outdated flags |
| `coop-coep` | `f917c0d00` 2026-05-27 | Michael Nutt | Separate from all three | add COOP and COEP headers; default to stricter CSP disallowing third party assets |
| `default-mongo-7` | `695dd3521` 2026-05-30 | Michael Nutt | origin/dev, HEAD | should default to mongo 7 on new installs |
| `dev` | `13afd01d6` 2026-06-16 | Jacob Weisz | origin/dev, HEAD | Merge pull request #3757 from sandstorm-io/migrate-sh |
| `dev-no-walkthrough` | `8bcf9599b` 2026-05-09 | Michael Nutt | origin/dev, HEAD | no-op safe disableGuidedTour since it doesn't show in dev mode anymore |
| `email-agent` | `1e3ad56a0` 2026-06-02 | Michael Nutt | Separate from all three | support non-hack-session email apis |
| `feat/passkey-auth` | `05f132ccc` 2026-05-06 | Ryan Singer | Separate from all three | fix(passkey): address code review findings (userHandle trust, nonloginCredentials, i18n, initiateLogin) |
| `fix/demo-login-launch-url-v2` | `df12f9506` 2026-06-06 | Michael Nutt | Separate from all three | demo user shows 'Create account' now instead of 'Demo' |
| `flaky-trash-test` | `981f8ee65` 2026-05-09 | Michael Nutt | origin/dev, HEAD | fix flaky grain trash test with better selector |
| `isolates-rebased` | `0c85d34a5` 2026-08-15 | Michael Nutt | HEAD | Fix isolate query parsing and system tests |
| `isolates-v2` | `44629cf0f` 2026-07-19 | Michael Nutt | Separate from all three | fix bazel build |
| `ldap-fixes` | `d00d4873d` 2026-03-07 | Michael Nutt | origin/dev, HEAD | better waiting for mongo to be ready |
| `master` | `194565d38` 2026-05-29 | Michael Nutt | Separate from all three | add draft release manual action |
| `meteor-2-asyncify` | `da9ed0654` 2026-02-06 | Michael Nutt | Separate from all three | hardening for some test warnings |
| `meteor-2.16-upgrade-deps` | `857695f29` 2026-02-23 | Michael Nutt | Separate from all three | gitignore package-lock.json for the moment |
| `meteor-2.16-upgrade-deps-rebased` | `d59411551` 2026-04-15 | Michael Nutt | origin/dev, HEAD | commit package-lock.json files |
| `meteor-3` | `082866944` 2026-02-13 | Michael Nutt | Separate from all three | fix lint error |
| `meteor-3-no-globalthis` | `4ac576f21` 2026-05-28 | Michael Nutt | Separate from all three | bump number of linting errors |
| `meteor-3-rebased` | `ae67f477b` 2026-05-11 | Michael Nutt | HEAD | fill in test coverage and fix a few issues the new tests exposed |
| `meteor-3.4-continuation` | `de2e96f3b` 2026-08-02 | Michael Nutt | HEAD | settle meteor-testapp package-lock |
| `meteor-3.4-continuation-visual` | `27ee2f587` 2026-08-01 | Michael Nutt | HEAD | add visual regression testing |
| `meteor-3.5` | `0296814d0` 2026-08-13 | Michael Nutt | HEAD | make nightwatch tests more reliable |
| `mn/demo-login-launch-url-v2` | `df12f9506` 2026-06-06 | Michael Nutt | Separate from all three | demo user shows 'Create account' now instead of 'Demo' |
| `mnutt-all` | `8fef84fb1` 2026-06-17 | Michael Nutt | Separate from all three | more validation of cross-app calls |
| `mongo-upgrade-clean` | `026f0d7f9` 2026-03-26 | Jacob Weisz | origin/dev, HEAD | Update MongoDB license from AGPL to SSPL |
| `nightwatch-vrt-base` | `25b7ed156` 2026-08-01 | Michael Nutt | Separate from all three | clickable comparisons |
| `os-interface` | `012c446bd` 2026-05-12 | Michael Nutt | Separate from all three | WIP desktop mode |
| `outbound-http-session` | `0154d98fd` 2026-06-16 | Michael Nutt | Separate from all three | fix race condition in startup registration |
| `outgoing-http` | `ae67f477b` 2026-05-11 | Michael Nutt | HEAD | fill in test coverage and fix a few issues the new tests exposed |
| `passkey-auth` | `1c950b5ff` 2026-05-08 | Michael Nutt | Separate from all three | counter regression check already handled by webauthn library |
| `raw-udp` | `8823230f6` 2026-03-22 | Michael Nutt | Separate from all three | bump lint error count (ugh) |
| `replace-ed25519-with-gpg` | `20421af08` 2026-10-03 | Michael Nutt | Separate from all three | tests should use non-expiring dummy keys |
| `runtime-env-variable` | `1b85bdb23` 2026-05-09 | Michael Nutt | origin/dev, HEAD | add SERVER_RUNTIME environment variable |
| `saml-cert-fixes` | `f061e92db` 2026-03-07 | Michael Nutt | Separate from all three | use secure crypto for generating random bytes for unique ids |
| `saml-fixes` | `231077a9e` 2026-02-14 | Jacob Weisz | origin/master | Merge pull request #3742 from sandstorm-io/docs-sandcats-recovery |
| `surface-powerbox-app-providers` | `d00d4873d` 2026-03-07 | Michael Nutt | origin/dev, HEAD | better waiting for mongo to be ready |
| `ui-touchup` | `df7fc8603` 2026-08-08 | Michael Nutt | HEAD | fix the rest of the test failures caused by selector changes |
| `warnings-cleanup` | `45696d8fd` 2026-08-10 | Michael Nutt | HEAD | limit bundle size warnings to client |
| `workerd` | `636c948e7` 2026-06-16 | Michael Nutt | Separate from all three | validate dev-isolate json bindings |

## Personal remote branches

| Ref | Tip and date | Tip author | Exact containment | Tip subject |
| --- | --- | --- | --- | --- |
| `mnutt/allow-web-workers` | `f896c30c0` 2026-03-07 | Michael Nutt | Separate from all three | relax csp to allow web workers; disable service workers by not loading them |
| `mnutt/app-creation-powerbox` | `8273acb16` 2026-08-21 | Michael Nutt | HEAD | preview drawer refinement |
| `mnutt/app-harness` | `a58d77984` 2026-03-31 | Michael Nutt | Separate from all three | add new spk app serve command |
| `mnutt/apparmor-profile` | `5a3021ad6` 2026-04-22 | Michael Nutt | origin/dev, HEAD | installer adds apparmor profile on ubuntu 24.04 |
| `mnutt/applist` | `917d84aae` 2015-08-14 | Drew Fisher | Separate from all three | Don't SHA256 for app identicons |
| `mnutt/bundle-mongo-openssl` | `dd63e9237` 2026-06-25 | Michael Nutt | Separate from all three | use actual artifact instead of old one |
| `mnutt/capnp-es` | `8d052ea59` 2026-05-20 | Michael Nutt | Separate from all three | add profiling and some performance optimizations |
| `mnutt/ci-apt-get` | `645fdc70d` 2026-05-09 | Michael Nutt | origin/dev, HEAD | ensure update is always run before apt-get |
| `mnutt/cmake` | `6e91e3f30` 2026-08-08 | Michael Nutt | HEAD | no longer need pinned version of python |
| `mnutt/coop-coep` | `f917c0d00` 2026-05-27 | Michael Nutt | Separate from all three | add COOP and COEP headers; default to stricter CSP disallowing third party assets |
| `mnutt/default-mongo-7` | `695dd3521` 2026-05-30 | Michael Nutt | origin/dev, HEAD | should default to mongo 7 on new installs |
| `mnutt/dev` | `eb25cb3c9` 2026-05-26 | Jacob Weisz | origin/dev, HEAD | Merge pull request #3755 from sandstorm-io/mediawiki-appkey |
| `mnutt/dev-no-walkthrough` | `8bcf9599b` 2026-05-09 | Michael Nutt | origin/dev, HEAD | no-op safe disableGuidedTour since it doesn't show in dev mode anymore |
| `mnutt/document-admin-stuff` | `efdd8a8d3` 2015-08-10 | Asheesh Laroia | Separate from all three | Add docs on user accounts |
| `mnutt/fix-675-testjenkins` | `9c2faa0d1` 2015-08-12 | Asheesh Laroia | Separate from all three | Fix insane half-written nonsense by me, oops |
| `mnutt/fix-disconnect-core-cap` | `9af1be3d5` 2015-07-16 | Jason Paryani | Separate from all three | Fix frontend disconnects causing problems with SandstormCore |
| `mnutt/fix-tests` | `d6880bcb4` 2026-02-01 | Michael Nutt | Separate from all three | merge dev |
| `mnutt/flaky-trash-test` | `981f8ee65` 2026-05-09 | Michael Nutt | origin/dev, HEAD | fix flaky grain trash test with better selector |
| `mnutt/full-isolates-capabilities` | `31287a4fa` 2026-06-24 | Michael Nutt | Separate from all three | update isolates nightwatch tests |
| `mnutt/gha-tests` | `30e58444a` 2026-02-01 | Michael Nutt | origin/dev, HEAD | build: pin meteortesting packages for compatibility |
| `mnutt/isolates-rebased` | `0c85d34a5` 2026-08-15 | Michael Nutt | HEAD | Fix isolate query parsing and system tests |
| `mnutt/isolates-v2` | `44629cf0f` 2026-07-19 | Michael Nutt | Separate from all three | fix bazel build |
| `mnutt/master` | `194565d38` 2026-05-29 | Michael Nutt | Separate from all three | add draft release manual action |
| `mnutt/meteor-2.16-upgrade-deps` | `c93020930` 2026-03-31 | Michael Nutt | origin/dev, HEAD | fork acme dns dependencies into sandstorm-org |
| `mnutt/meteor-2.16-upgrade-deps-rebased` | `d59411551` 2026-04-15 | Michael Nutt | origin/dev, HEAD | commit package-lock.json files |
| `mnutt/meteor-3` | `082866944` 2026-02-13 | Michael Nutt | Separate from all three | fix lint error |
| `mnutt/meteor-3-no-globalthis` | `3c1a943ff` 2026-05-27 | Michael Nutt | Separate from all three | remove globalThis |
| `mnutt/meteor-3-rebased` | `ae67f477b` 2026-05-11 | Michael Nutt | HEAD | fill in test coverage and fix a few issues the new tests exposed |
| `mnutt/meteor-3.4-continuation` | `de2e96f3b` 2026-08-02 | Michael Nutt | HEAD | settle meteor-testapp package-lock |
| `mnutt/meteor-3.4-continuation-visual` | `27ee2f587` 2026-08-01 | Michael Nutt | HEAD | add visual regression testing |
| `mnutt/meteor-3.5` | `0296814d0` 2026-08-13 | Michael Nutt | HEAD | make nightwatch tests more reliable |
| `mnutt/missing-overwrite-dav-header` | `c85cf7405` 2015-11-16 | Michael Nutt | origin/dev, origin/master, HEAD | Protect against missing Overwrite header in WebDAV MOVE or COPY |
| `mnutt/mn/demo-login-launch-url-v2` | `df12f9506` 2026-06-06 | Michael Nutt | Separate from all three | demo user shows 'Create account' now instead of 'Demo' |
| `mnutt/mn/mongo-upgrade-clean` | `508ba20f6` 2026-02-02 | Michael Nutt | Separate from all three | ci: update Chrome to v142 and disable lint count check |
| `mnutt/mnutt-all` | `c402fe6ee` 2026-06-17 | Michael Nutt | Separate from all three | don't allow passing live ClaimedCapability handles to other grains, they won't work |
| `mnutt/mongo-upgrade` | `1ce69a98b` 2026-02-01 | Michael Nutt | Separate from all three | bump boringssl version |
| `mnutt/mongo-upgrade-clean` | `026f0d7f9` 2026-03-26 | Jacob Weisz | origin/dev, HEAD | Update MongoDB license from AGPL to SSPL |
| `mnutt/mongo-upgrade-fixes` | `57dce2100` 2026-03-26 | Michael Nutt | origin/dev, HEAD | ensure copied file gets original's permissions |
| `mnutt/nightwatch-vrt-base` | `25b7ed156` 2026-08-01 | Michael Nutt | Separate from all three | clickable comparisons |
| `mnutt/offer-template-clipboard` | `c15848393` 2016-02-09 | Michael Nutt | Separate from all three | markdown format offer template setup steps |
| `mnutt/offer-template-grain-titles` | `165364b41` 2016-02-28 | Michael Nutt | origin/dev, origin/master, HEAD | clean up my js style |
| `mnutt/old-kernel-testing` | `afdd29de9` 2026-06-25 | Michael Nutt | Separate from all three | use lima for old kernels |
| `mnutt/outbound-http-session` | `0154d98fd` 2026-06-16 | Michael Nutt | Separate from all three | fix race condition in startup registration |
| `mnutt/passkey-auth` | `1c950b5ff` 2026-05-08 | Michael Nutt | Separate from all three | counter regression check already handled by webauthn library |
| `mnutt/patch-1` | `ad01a077f` 2015-10-24 | Michael Nutt | origin/dev, origin/master, HEAD | Typo in offer template data |
| `mnutt/patch-2` | `55f46e380` 2015-11-03 | Michael Nutt | origin/dev, origin/master, HEAD | Update Web Publishing helper docs to install libtool dependency |
| `mnutt/patch-3` | `88b834ba0` 2021-08-17 | Michael Nutt | origin/dev, origin/master, HEAD | Add more owncloud/nextcloud client headers |
| `mnutt/raw-udp` | `8823230f6` 2026-03-22 | Michael Nutt | Separate from all three | bump lint error count (ugh) |
| `mnutt/recover-sandcats` | `2c8ac76e2` 2026-01-29 | Michael Nutt | origin/master | add recover-sandcats.sh script to regenerate client cert |
| `mnutt/replace-ed25519-with-gpg` | `20421af08` 2026-10-03 | Michael Nutt | Separate from all three | tests should use non-expiring dummy keys |
| `mnutt/runtime-env-variable` | `1b85bdb23` 2026-05-09 | Michael Nutt | origin/dev, HEAD | add SERVER_RUNTIME environment variable |
| `mnutt/ui-touchup` | `df7fc8603` 2026-08-08 | Michael Nutt | HEAD | fix the rest of the test failures caused by selector changes |
| `mnutt/warnings-cleanup` | `45696d8fd` 2026-08-10 | Michael Nutt | HEAD | limit bundle size warnings to client |
| `mnutt/web-publishing-path-spaces` | `801ece9bc` 2016-11-03 | Michael Nutt | Separate from all three | decode spaces in web-published URLs |
| `mnutt/webdav-bridge` | `3905ad4d6` 2015-08-30 | Michael Nutt | Separate from all three | fix typo in proxy response |
| `mnutt/webdav-bridge-support` | `eba9c9a02` 2015-10-04 | Michael Nutt | Separate from all three | Merge branch 'master' into webdav-bridge-support |
| `mnutt/windows-vagrant` | `05d85ffae` 2015-02-28 | Asheesh Laroia | Separate from all three | On Windows, use smb rather than NFS |
| `mnutt/workerd` | `f11a66172` 2026-06-16 | Michael Nutt | Separate from all three | run isolate test in ci |

## Upstream remote branches

| Ref | Tip and date | Tip author | Exact containment | Tip subject |
| --- | --- | --- | --- | --- |
| `origin/actions-chrome` | `dc2fb0b47` 2022-08-05 | Jacob Weisz | Separate from all three | bash correctly |
| `origin/allow-blob` | `ec3805d76` 2016-09-29 | Kenton Varda | Separate from all three | Allow apps to display 'data:' and 'blob:' URLs in their iframe. |
| `origin/app-review-guide` | `b594d1ca0` 2020-07-23 | Jacob Weisz | Separate from all three | Docs: Third pass on app review guide |
| `origin/asheesh-referral-program-wip-dont-merge` | `113123555` 2015-11-12 | Asheesh Laroia | Separate from all three | verywip |
| `origin/check-for-all-vagrant-plugins-that-we-need` | `44faf39c0` 2015-06-05 | Asheesh Laroia | Separate from all three | Also check for vagrant-libvirt plugin |
| `origin/chromium-clang` | `4c96b3e9f` 2018-03-11 | Kenton Varda | Separate from all three | Automatically download up-to-date Clang from Chromium project. |
| `origin/content-range` | `299833eab` 2017-03-11 | Kenton Varda | Separate from all three | Extend WebSession to support range requests. |
| `origin/cron` | `d7ac7ea5f` 2017-03-11 | Kenton Varda | Separate from all three | Work around Cap'n Proto compiler bug with constants inside templates. |
| `origin/dev` | `e2025b92b` 2026-09-27 | Jacob Weisz | origin/dev | Merge pull request #3786 from CodeXAniket/deprecate-install-i-flag |
| `origin/docs-give-sample-code-for-handle` | `8889dd4a7` 2016-09-14 | Asheesh Laroia | Separate from all three | Contextualize the algorithm |
| `origin/docs-platform-stacks` | `741db4de0` 2025-11-12 | Jacob Weisz | origin/master | Update vagrant-spk stacks list |
| `origin/drawio-key-transition` | `dc9450719` 2016-09-09 | Asheesh Laroia | Separate from all three | Add draw.io key replacement |
| `origin/grains-question-mark-issue2045` | `68929a0ed` 2016-06-08 | Asheesh Laroia | Separate from all three | wip |
| `origin/inline-powerbox-kenton` | `859476c58` 2016-02-04 | Kenton Varda | Separate from all three | Inline powerbox: Various cleanups and security tightening. |
| `origin/install-sh-org` | `b39f22e7d` 2026-02-24 | Jacob Weisz | origin/dev, HEAD | Use local.sandstorm.org for local installs |
| `origin/installer-tests-remove-postfix-correctly` | `d8e8c2e68` 2016-10-12 | Asheesh Laroia | Separate from all three | installer-tests: Use a more specific cleanup function |
| `origin/latest-ubuntu` | `e90d309de` 2025-05-19 | Jacob Weisz | Separate from all three | CI: Use latest Ubuntu |
| `origin/master` | `a97cf3ee1` 2026-05-25 | Jacob Weisz | origin/master | Merge pull request #3769 from sandstorm-io/remove-irc-ggroups |
| `origin/mediawiki-appkey` | `9b36e10d4` 2026-04-16 | Jacob Weisz | origin/dev, HEAD | Replace MediaWiki app key |
| `origin/migrate-sh` | `d0b269a61` 2026-05-27 | Jacob Weisz | origin/dev, HEAD | Check for free space before migrating |
| `origin/on-sandstorm-failure-dont-kill-update-monitor` | `65711ab19` 2015-10-19 | Asheesh Laroia | Separate from all three | If Sandstorm fails, don't kill the update process |
| `origin/plus-asheesh-nsenter` | `376f7005a` 2016-05-04 | Asheesh Laroia | Separate from all three | wip |
| `origin/railroad` | `303bf4f0f` 2015-08-27 | Asheesh Laroia | Separate from all three | Use @neynah suggested colors for install icon on hover |
| `origin/search` | `20a6f3ded` 2017-02-13 | Kenton Varda | Separate from all three | Answer @dwrensha's questions. |
| `origin/spk-dev-prints-info-about-grain-log` | `e3c199ba0` 2016-05-10 | Asheesh Laroia | Separate from all three | spk dev: Remark that app logs are available somewhere |
| `origin/strictnullchecks-off` | `f5997862f` 2022-10-12 | Jacob Weisz | Separate from all three | Typecheck: Disable strictNullChecks |
| `origin/tutorial-thinking-out-loud` | `6925deccc` 2016-08-13 | Asheesh Laroia | Separate from all three | this works too |
| `origin/update-gpg-sig` | `1aa0c13eb` 2026-06-16 | Jacob Weisz | origin/dev | Replace release GPG key |
| `origin/windows-vagrant` | `05d85ffae` 2015-02-28 | Asheesh Laroia | Separate from all three | On Windows, use smb rather than NFS |
| `origin/work-in-progress-reorganize-home-screen` | `7ab895e64` 2016-01-08 | Asheesh Laroia | Separate from all three | Move "restore backup" to /grains page |

## Ryan Singer remote branches

| Ref | Tip and date | Tip author | Exact containment | Tip subject |
| --- | --- | --- | --- | --- |
| `ryansinger/allow-blob` | `ec3805d76` 2016-09-29 | Kenton Varda | Separate from all three | Allow apps to display 'data:' and 'blob:' URLs in their iframe. |
| `ryansinger/app-review-guide` | `b594d1ca0` 2020-07-23 | Jacob Weisz | Separate from all three | Docs: Third pass on app review guide |
| `ryansinger/asheesh-referral-program-wip-dont-merge` | `113123555` 2015-11-12 | Asheesh Laroia | Separate from all three | verywip |
| `ryansinger/check-for-all-vagrant-plugins-that-we-need` | `44faf39c0` 2015-06-05 | Asheesh Laroia | Separate from all three | Also check for vagrant-libvirt plugin |
| `ryansinger/chromium-clang` | `4c96b3e9f` 2018-03-11 | Kenton Varda | Separate from all three | Automatically download up-to-date Clang from Chromium project. |
| `ryansinger/content-range` | `299833eab` 2017-03-11 | Kenton Varda | Separate from all three | Extend WebSession to support range requests. |
| `ryansinger/cron` | `d7ac7ea5f` 2017-03-11 | Kenton Varda | Separate from all three | Work around Cap'n Proto compiler bug with constants inside templates. |
| `ryansinger/dev` | `3becf4b02` 2026-04-28 | Jacob Weisz | origin/dev, HEAD | Merge pull request #3753 from mnutt/meteor-2.16-upgrade-deps-rebased |
| `ryansinger/feat/passkey-auth` | `05f132ccc` 2026-05-06 | Ryan Singer | Separate from all three | fix(passkey): address code review findings (userHandle trust, nonloginCredentials, i18n, initiateLogin) |
| `ryansinger/grains-question-mark-issue2045` | `68929a0ed` 2016-06-08 | Asheesh Laroia | Separate from all three | wip |
| `ryansinger/inline-powerbox-kenton` | `859476c58` 2016-02-04 | Kenton Varda | Separate from all three | Inline powerbox: Various cleanups and security tightening. |
| `ryansinger/installer-tests-remove-postfix-correctly` | `d8e8c2e68` 2016-10-12 | Asheesh Laroia | Separate from all three | installer-tests: Use a more specific cleanup function |
| `ryansinger/master` | `231077a9e` 2026-02-14 | Jacob Weisz | origin/master | Merge pull request #3742 from sandstorm-io/docs-sandcats-recovery |
| `ryansinger/mediawiki-appkey` | `9b36e10d4` 2026-04-16 | Jacob Weisz | origin/dev, HEAD | Replace MediaWiki app key |
| `ryansinger/migrate-sh` | `26f10d701` 2026-04-18 | Jacob Weisz | origin/dev, HEAD | Add migration script |
| `ryansinger/on-sandstorm-failure-dont-kill-update-monitor` | `65711ab19` 2015-10-19 | Asheesh Laroia | Separate from all three | If Sandstorm fails, don't kill the update process |
| `ryansinger/plus-asheesh-nsenter` | `376f7005a` 2016-05-04 | Asheesh Laroia | Separate from all three | wip |
| `ryansinger/railroad` | `303bf4f0f` 2015-08-27 | Asheesh Laroia | Separate from all three | Use @neynah suggested colors for install icon on hover |
| `ryansinger/search` | `20a6f3ded` 2017-02-13 | Kenton Varda | Separate from all three | Answer @dwrensha's questions. |
| `ryansinger/spk-dev-prints-info-about-grain-log` | `e3c199ba0` 2016-05-10 | Asheesh Laroia | Separate from all three | spk dev: Remark that app logs are available somewhere |
| `ryansinger/windows-vagrant` | `05d85ffae` 2015-02-28 | Asheesh Laroia | Separate from all three | On Windows, use smb rather than NFS |
| `ryansinger/work-in-progress-reorganize-home-screen` | `7ab895e64` 2016-01-08 | Asheesh Laroia | Separate from all three | Move "restore backup" to /grains page |
