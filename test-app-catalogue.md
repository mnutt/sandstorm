# Sandstorm test app catalogue

This document catalogues the application packages used by Sandstorm's browser
and system tests, together with their known source repositories. It was last
checked against the public GitHub repositories on 2026-08-10.

## Repository-owned fixtures

| Fixture | Source | Notes |
| --- | --- | --- |
| `meteor-testapp.spk` | [`meteor-testapp/`](meteor-testapp/) | Built from source by the `meteor-testapp-spk` CMake target. It tests profile data exposed through `kenton:accounts-sandstorm` and the `SERVER_RUNTIME` environment contract. |
| `test-app.spk` | [`src/sandstorm/test-app/`](src/sandstorm/test-app/) | Native C++ fixture compiled as part of Sandstorm. It exercises system APIs, scheduling, Powerbox behavior, and web publishing. |

The Meteor fixture currently builds against Sandstorm's repository-local fork
of `kenton:accounts-sandstorm` in
[`shell/packages/accounts-sandstorm/`](shell/packages/accounts-sandstorm/).
The original package has its own organization-owned repository:
[`sandstorm-io/meteor-accounts-sandstorm`](https://github.com/sandstorm-io/meteor-accounts-sandstorm).

## Organization-owned external fixtures

| Test artifact | App ID | Source | Status |
| --- | --- | --- | --- |
| `test-11.spk` | `rwyva77wj1pnj01cjdj2kvap7c059n9ephyyg5k4s5enh5yw9rxh` | [`sandstorm-io/sandstorm-test-python`](https://github.com/sandstorm-io/sandstorm-test-python) | Confirmed. All current call sites use app version 11. The repository's historical `powerbox` and `test-ip-interface` branches are superseded by the implementation on `master`. |
| `collections3.spk` | `s3u2xgmqwznz2n3apf30sm3gw1d85y029enw5pymx734cnk5n78h` | [`sandstorm-io/collections-app`](https://github.com/sandstorm-io/collections-app) | Confirmed by exact app ID. The current manifest is version 7; the tests deliberately install historical version 3. |

### Python contact-test variant

`sandstorm-test-python7.spk`, used by the contact Powerbox tests, is attributed
in the test source to `sandstorm-io/sandstorm-test-python`. The tests expect app
ID `umeqc9yhncg63fjj6sahtw30nf99kfm6tgkuz8rmhn5dqtusnwah`, which does not match
the app ID in the repository's current package definitions. This may be a
historical re-key or a build from a revision that is not represented by the
current branches. The artifact and repository history need to be compared
before treating this as an exactly reproducible source match.

## Fixtures hosted outside `sandstorm-io`

| Test artifact | App ID | Source | Status |
| --- | --- | --- | --- |
| `background-test-0.spk` | `duvq9t519fdcpetkk2s1axe1hdy91zc5svhzas2yfqpn8df9cd40` | [`jparyani/sandstorm-test-app`, `background-test` branch](https://github.com/jparyani/sandstorm-test-app/tree/background-test) | Confirmed by exact app ID. |
| `background-test-drop-wakelock-1.spk` | `duvq9t519fdcpetkk2s1axe1hdy91zc5svhzas2yfqpn8df9cd40` | [`jparyani/sandstorm-test-app`, `background-test-drop-wakelock` branch](https://github.com/jparyani/sandstorm-test-app/tree/background-test-drop-wakelock) | Confirmed by exact app ID. |
| `sandstorm-powerbox-test-app4.spk` | `ygpudg61w49gg0x1t2gw4p7q2q7us24gxsyr1as1hf0ezn2uycth` | [`jparyani/sandstorm-test-app`, `powerbox` branch](https://github.com/jparyani/sandstorm-test-app/tree/powerbox) | The tests name this branch as the source, but its current package definition has a different app ID. It is a likely source lineage, not yet a confirmed reproducible checkout. |
| `ssjekyll8.spk` | `nqmcqs9spcdpmqyuxemf0tsgwn8awfvswc58wgk375g4u25xv6yh` | [`kentonv/ssjekyll`](https://github.com/kentonv/ssjekyll) | Confirmed by exact app ID. The current manifest is version 10; the test artifact is version 8. |
| `gitweb5.spk` | `6va4cjamc21j0znf5h5rrgnv0rpyvh1vaxurkrgknefvj0x63ash` | [`dwrensha/gitweb-sandstorm`](https://github.com/dwrensha/gitweb-sandstorm) | Confirmed by exact app ID. The current manifest is version 10; the test artifact is version 5. |
| `roundcube-6.spk` | `0qhha1v9ne1p42s5jw7r6qq6rt5tcx80zpg1f5ptsg7ryr4hws1h` | [`jparyani/roundcubemail`, `sandstorm` branch](https://github.com/jparyani/roundcubemail/tree/sandstorm) | Confirmed by exact app ID. The current Sandstorm manifest is version 11; the test artifact is version 6. |
| `apihost-testapp.spk` | `w304h9n5rjx1pzfa8e4guheue5mq3dkwv63aajy1rscupw6e38mh` | [`kentonv/apihost-testapp`](https://github.com/kentonv/apihost-testapp) | Confirmed by exact app ID. |

The historical Sandstorm app directory also points Roundcube, GitWeb, and
Hacker CMS to these repositories:
[`sandstorm.io/apps`](https://sandstorm.io/apps/index.html).

## Current artifact URLs

The browser tests currently install the external fixtures from these immutable-looking,
but not locally checksummed, URLs:

| Artifact | URL |
| --- | --- |
| `apihost-testapp.spk` | `https://dl.sandstorm.org/testapps/apihost-testapp.spk` |
| `background-test-0.spk` | `https://dl.sandstorm.org/testapps/background-test-0.spk` |
| `background-test-drop-wakelock-1.spk` | `https://dl.sandstorm.org/testapps/background-test-drop-wakelock-1.spk` |
| `collections3.spk` | `https://dl.sandstorm.org/testapps/collections3.spk` |
| `gitweb5.spk` | `https://dl.sandstorm.org/testapps/gitweb5.spk` |
| `roundcube-6.spk` | `https://dl.sandstorm.org/testapps/roundcube-6.spk` |
| `sandstorm-powerbox-test-app4.spk` | `https://dl.sandstorm.org/testapps/sandstorm-powerbox-test-app4.spk` |
| `sandstorm-test-python7.spk` | `https://dl.sandstorm.org/testapps/sandstorm-test-python7.spk` |
| `ssjekyll8.spk` | `https://dl.sandstorm.org/testapps/ssjekyll8.spk` |
| `test-11.spk` | `https://dl.sandstorm.org/testapps/test-11.spk` |

## Consolidation notes

A future organization-owned test-app repository should preserve:

- Git history where it is available.
- Existing fixture signing keys and app IDs.
- Every historical SPK used for compatibility and upgrade testing.
- A mapping from each SPK to its exact source commit, package ID, app ID, and
  SHA-256 digest.
- Immutable artifact URLs; old versions should never be overwritten.

The Sandstorm repository should pin a test-app repository revision or artifact
manifest rather than following the newest test-app build implicitly. Before
migration, the `sandstorm-powerbox-test-app4.spk` and
`sandstorm-test-python7.spk` identity discrepancies should be resolved by
unpacking the deployed artifacts and walking their source repository histories.
