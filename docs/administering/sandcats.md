# Sandcats.org / Sandhost backend

Sandstorm supports an opt-in Sandhost Installation API alongside legacy Sandcats.io.
The new backend's default domain is **sandcats.org**. The test deployment uses
**sandhost.org**. Existing `.sandcats.io` installations are not migrated automatically.

There are three separate addresses to keep straight:

* The server hostname, for example `alice.sandhost.org`.
* The managed domain, `sandhost.org` for testing or `sandcats.org` by default.
* The Installation API webkey, exported by the DNS grain as `https://api-…/#TOKEN`.
  The grain's `/grain/...` browser URL is not an API endpoint. Use the actual export;
  no fixed `api.sandcats.org` endpoint or built-in bearer token is assumed.

In the DNS grain, set **API origin** to the webkey URL's origin (everything before
`#TOKEN`, without a trailing slash). Restart its DNS listeners after saving the
configuration. A mismatched origin causes `invalid_signature`; stopped listeners
prevent public DNS resolution and certificate validation even when registration succeeds.

## New installations

Set `SANDCATS_API_WEBKEY` to the **full URL, including `#TOKEN`**:

```sh
sudo env SANDCATS_API_WEBKEY='https://api-…/#TOKEN' SANDCATS_BACKEND=sandhost \
  OVERRIDE_SANDCATS_BASE_DOMAIN=sandhost.org \
  bash install.sh /absolute/path/to/new-sandstorm-bundle.tar.xz
```

Use a bundle built with the new backend support. Omit `OVERRIDE_SANDCATS_BASE_DOMAIN`
to use `sandcats.org`. If you omit `SANDCATS_API_WEBKEY`, the interactive installer
prompts for the URL. You can paste a URL with or without a slash before `#TOKEN`.
The installer stores it in `var/sandcats/api-webkey` for subsequent API requests.
This public Installation API webkey routes requests to the DNS grain through Sandstorm;
it does not need to be kept secret. The installation's private signing key proves
hostname ownership and must remain private.

Choose `observed` for a public IPv4 server, or `explicit` and a Tailscale IPv4 address
for a server reachable through your tailnet. The DNS records are public in either case;
an explicit Tailscale address is only reachable by clients with tailnet connectivity.
DNS-01 certificate validation does not require public inbound HTTP connectivity.

For unattended installs, provide `DESIRED_SANDCATS_NAME`, `SANDCATS_REGISTRATION_EMAIL`,
`SANDCATS_ADDRESS_MODE` and, for explicit mode, `SANDCATS_IP_ADDRESS`, in addition to
the usual unattended installer settings. Legacy reservation tokens are not used by
this backend. The installer extracts the bundle before registration, then uses its Node runtime and
shared Sandhost client before writing configuration and starting Sandstorm.
Sandhost recovery likewise requires the helper from an installed bundle.

## Existing installations and API updates

Register or recover the intended new hostname first; switching backend settings alone
does not transfer ownership of a legacy name. For an already registered new-backend name,
put its PEM installation key in `var/sandcats/id_rsa` and its API webkey in
`var/sandcats/api-webkey`, and configure:

```
SANDCATS_BACKEND=sandhost
SANDCATS_BASE_DOMAIN=sandhost.org
SANDCATS_ADDRESS_MODE=observed
BASE_URL=https://alice.sandhost.org
WILDCARD_HOST=*.alice.sandhost.org
```

Keep the rest of the installation's settings, including `HTTPS_PORT`. The private
directory must have mode `0700` and belong to `SERVER_USER`; the webkey and
signing key must be readable by that user. Restart Sandstorm after changes.

The updater fetches signed ownership status on startup, then checks approximately once
a minute with jitter. Public-IP updates are sent only when the observed IP changes.
Requests use IPv4 and respect `BIND_IP`, except loopback/unspecified binding. Failures
back off to roughly 15 minutes without overlapping requests. In explicit mode the
configured Tailscale address is applied without public-IP discovery. Change
`SANDCATS_IP_ADDRESS` and restart when that address changes.

Replace `var/sandcats/api-webkey` with another valid exported URL to change the API
endpoint/token, keeping it readable by `SERVER_USER`, then restart. Keep the DNS-hosting
Sandstorm server at its existing hostname; it need not use the managed domain.

## Recovery and backups

The installer accepts `recover` at the name prompt. For an existing installation run:

```sh
sudo bash /opt/sandstorm/latest/recover-sandcats.sh /opt/sandstorm
```

The script reads the backend and domain from `sandstorm.conf`; legacy recovery remains
available. The new backend uses `/recover` and signed `/recover/confirm`. It stages a
new key as `id_rsa.recovery` and replaces `id_rsa` only after the API accepts it, retaining
the old key as `id_rsa.before-recovery`. A failure retains the candidate for retry.
If confirmation succeeds remotely but the connection drops, that candidate may already
own the name: retain it and repeat recovery rather than deleting it. Restart Sandstorm
after recovery. The new protocol does not use the legacy X.509 certificate files.

Back up the installation key securely and retain the API webkey URL.
The webkey grants access to the public API; the private key proves hostname ownership. Revoking
the API export prevents updates until its replacement is installed; ownership recovery
replaces the registered public key so the old installation key no longer works.

## HTTPS verification

The certificate UI selects this backend automatically from configuration. DNS-01 uses
the same API webkey and installation signing key and supports simultaneous wildcard and base-hostname TXT
values with selective cleanup. Arbitrary challenge hostnames are rejected, so the ACME
library's synthetic dry run is skipped. Other DNS providers retain their existing behavior.

Before using a deployment for production certificates, confirm public delegation and
base/wildcard DNS answers, then issue and renew using the Let's Encrypt **staging**
directory (`https://acme-staging-v02.api.letsencrypt.org/directory`). Set `ACME_DIRECTORY`
to that URL during installation to test staging issuance through the installer.
Staging certificates are intentionally untrusted by browsers. The automated tests
exercise the protocol and adapter; they do not establish successful public certificate
issuance or replica failover.

# About legacy Sandcats.io

Sandcats.io is a free-of-cost dynamic DNS service run by the Sandstorm
development team. In a nutshell:

* Sandstorm users can have a free domain name of the form `example.sandcats.io`.

* Sandstorm can automatically set up that domain, including a valid HTTPS certificate for it.

* It's an official part of Sandstorm and we recommend people use it!

In more detail:

* Users host their own servers. A hostname like `example.sandcats.io` points at the IP address of
  someone's server, and that server holds its own private keys.

* It assumes your server should be reachable from the global Internet.

* It's an optional service. Keep reading this page to learn how to stop using it.

* It points at your server's public (globally routable) IP address, which it auto-detects. Read
  elsewhere about setting up Sandstorm to use an [internal IP address](faq.md#how-do-i-use-sandstorm-with-an-internal-ip-address).

The purpose is to help people who run their own server have a working hostname and HTTPS (TLS/SSL)
certificate without having to think hard about the domain name system or public key infrastructure.

# Features

Sandcats is **integrated into the Sandstorm installer** so that when you install Sandstorm, you get
working DNS, including wildcard DNS, as well as working HTTPS for the main Sandstorm interface.

The Sandcats backend is **free, open source software** under the Apache License 2.0; you can [view
and participate in the project](https://github.com/sandstorm-io/sandcats).

The Sandcats DNS service provides **60-second** latency for IP address updates via a custom UDP
protocol to detect address changes. To achieve this low latency, when Sandcats integration is
enabled, your Sandstorm server sends a UDP ping message to the central Sandcats service every 60
seconds.

# Administering your sandcats.io subdomain

## Finding debugging information

By default, Sandstorm stores a log in a text file at `/opt/sandstorm/var/log/sandstorm.log`. You can
read it by running this command:

```bash
sudo less /opt/sandstorm/var/log/sandstorm.log
```

This launches a tool called `less`; for help using `less`, read [this
tutorial](http://www.networkredux.com/answers/linux-in-general/working-with-files/how-do-i-use-the-less-command-in-linux).

## Disabling the sandcats service

If your Sandstorm server used to use `sandcats.io` but you want to transition to
your own domain name (with wildcard DNS), you can disable the sandcats-related code
in your Sandstorm install.

To do that, open your `/opt/sandstorm/sandstorm.conf` file in a text editor and notice this line:

```bash
SANDCATS_BASE_DOMAIN=sandcats.io
```

Remove that line entirely, then save and quit your editor. Run `sudo service sandstorm restart` to
cause Sandstorm to notice your changes to its configuration file.

That will disable the sandcats-related functionality in your Sandstorm server on your system. This
means your domain will stop automatically updating its IP address.

Note that this does not delete any domains you registered. That's OK with us; from our perspective,
there's no need to email us to delete your domain.

## Re-installing Sandstorm and keeping your sandcats domain

If you have already registered a domain like `example.sandcats.io` as part of installing Sandstorm,
but you find yourself doing a fresh install of Sandstorm, you can use our **email-based recovery**
system.

You won't need any files from the old Sandstorm install. Instead, run the Sandstorm install script
(which we call `install.sh`) on a new server; follow the prompts to **recover a domain** by typing
`help` at the Sandcats prompts.

**Overview.** This process will:

- Ask you what `sandcats.io` subdomain you use.

- Send you an email with a short-term token.

- Ask you for the token, then pass it to the sandcats.io service.

The install will continue and your new Sandstorm install will be bound to `example.sandcats.io`.

**Full details** for those who are curious.

- When you run the `install.sh` script, if you choose mode `1` for a full server, and you say `yes`
  to the defaults, `install.sh` prepares to enable `sandcats.io` (even if you end up not using the
  `sandcats.io` service).

- Specifically, `install.sh` looks for an existing client certificate on your system in
  `/opt/sandstorm/var/sandcats/id_rsa.private.combined`. `sandcats.io` uses client certificates to
  identify a Sandstorm server as controlling a specific domain like `example.sandcats.io`.  If
  `install.sh` does not find one, it generates one using `openssl`.

- `install.sh` asks via the console what sandcats domain you want to **register.** At this point,
  you can type `help`. This changes the question - `install.sh` now asks what domain you want to
  **recover.** Provide your sandcats hostname.

- `install.sh` then uses `curl` to ask `sandcats.io` to send an email to the address that you
  provided when first registering the domain. The email contains a small bit of text that serves as
  a one-time-use recovery token.

- `install.sh` waits for you to receive the email and asks via the console for your recovery token.

- `install.sh` sends that recovery token to `sandcats.io` using `curl`, while also providing the
  client certificate currently on your system (`/opt/sandstorm/var/sandcats`). If the recovery token
  matches what the server expects, then the server updates your user registration to trust the
  client certificate on your system.

## Manually moving sandcats client certificates to a new Sandstorm install

If you prefer, you can move your `sandcats.io` credentials to a new Sandstorm install without
running the `install.sh` script. We call that **file-based recovery.** Here are the steps.

* Find your three three `id_rsa` certificate files (usually `/opt/sandstorm/var/sandcats`) and keep
  them safe somewhere. Also keep a copy of `/opt/sandstorm/var/sandcats/https` if it exists.

* Do a new Sandstorm install, presumably on a new server somewhere. It will install to
  `/opt/sandstorm`. You should choose a non-sandcats.io host name during this process, such as using
  literally `example.com`.

* Copy those three `id_rsa` certificate files from the old server to the new server's Sandcats
  directory, `/opt/sandstorm/var/sandcats`. Do the same for `/opt/sandstorm/var/sandcats/https` if
  you backed it up.

* In your new Sandstorm install, ensure you have your `BASE_URL` and `WILDCARD_HOST` set properly.
  If your sandcats.io subdomain is `example`, then you'll need `BASE_URL=example.sandcats.io` and
  `WILDCARD_HOST=*.example.sandcats.io`. Consider copying these values from the old server's
  `sandstorm.conf`.

* Edit the new server's `sandstorm.conf` to contain this line: `SANDCATS_BASE_DOMAIN=sandcats.io`

* Now restart Sandstorm by running `sudo service sandstorm stop ; sudo service sandstorm start`, and
  wait at least 60 seconds.

* Your DNS hostname should have auto-updated. Check that DNS is working with `nslookup
  <myname>.sandcats.io` from another machine. This will help eliminate DNS as an issue when trying
  to access your server.

## Diagnosing "Not Authorized" problems

If you see `Not Authorized` in your log files, the sandcats.io service is returning HTTP code 403
for at least one request from your server.

One reason this occurs is if you have the wrong `id_rsa*` certificate files in
`/opt/sandstorm/var/sandcats`. You can fix this problem using the email-based recovery system; for
now, this requires using `install.sh` on a throwaway VM. Once your new certificate files are
registered with `sandcats.io`, you can move them to whichever server you want using file-based
recovery.

Another reason you might see `Not Authorized` in the log files is if your server has run afoul of
sandcats.io's defense in depth against Sandstorm bugs.

In either case, if you need further help, please email support@sandstorm.io!

# Terms of service, privacy policy, & contact information

Sandcats.io has the following formal documents:

* [Sandcats.io privacy policy](https://sandcats.io/privacy)
* [Sandcats.io terms of service](https://sandcats.io/terms)

If you have more questions, or are having trouble, email:

[support@sandstorm.io](mailto:support@sandstorm.io)
