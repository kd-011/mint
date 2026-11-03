# Self-hosting Mint

Mint holds your bank data, so how you expose it matters more than how you install it. Read "How Mint is locked" first, whichever recipe you pick.

## How Mint is locked

Mint has no sign-in page of its own. It trusts a reverse proxy that authenticates you and then passes two headers:

- `Remote-User`: the login name. It must equal `MINT_USER`.
- `X-Mint-Gate`: a shared secret equal to `MINT_GATE_KEY` (32 or more characters; `openssl rand -hex 32` makes one). A request without it is refused even with the right user name, so a port opened by mistake does not expose your data.

On top of that there is a fingerprint lock (a passkey, on by default). After the gateway lets you in, every data route still answers `423 locked` until you unlock with a fingerprint or device PIN. The lock is bound to the host name in `MINT_ORIGIN`, so set it to the https address you really serve Mint from. Passkeys need https, apart from `localhost`.

Mint listens on `127.0.0.1:8970` and nowhere else. Keep it that way: the proxy must be the only thing that can reach that port, and it must overwrite any `Remote-User` a client sends.

The Redbark webhook path, `/api/redbark/webhook`, is the one route that skips the login, because Redbark cannot sign in. Mint checks the HMAC signature itself. Webhooks are optional. `/healthz` and the PWA install assets are open too.

## Caddy with Authelia

Any forward-auth proxy works (Authentik, oauth2-proxy, Traefik forward auth). This is the setup with Caddy and [Authelia](https://www.authelia.com/integration/proxies/caddy/), whose Caddy page gives the `forward_auth` block and says `Remote-User` carries the username:

```
mint.example.com {
    @webhook path /api/redbark/webhook
    handle @webhook {
        reverse_proxy 127.0.0.1:8970
    }
    handle {
        forward_auth authelia:9091 {
            uri /api/authz/forward-auth
            copy_headers Remote-User
        }
        reverse_proxy 127.0.0.1:8970 {
            header_up X-Mint-Gate {env.MINT_GATE_KEY}
        }
    }
}
```

Give Caddy the same `MINT_GATE_KEY` in its environment (a systemd `EnvironmentFile=` is the usual way). The two copies must match; rotate both and restart both. Set `MINT_USER` to the Authelia user name that should be allowed in, and `MINT_ORIGIN=https://mint.example.com`.

## Tailscale

[Tailscale Serve](https://tailscale.com/kb/1312/serve) puts a local service on `https://<device>.<tailnet>.ts.net` for your own tailnet only, and proxies to `http://127.0.0.1`. It adds identity headers such as `Tailscale-User-Login`, but it sends no `Remote-User` or shared secret and cannot add custom headers. Put a tiny Caddy between the two to add them. The tailnet then acts as the login:

```
# /etc/caddy/Caddyfile: loopback only, reached through Tailscale Serve
http://127.0.0.1:8971 {
    reverse_proxy 127.0.0.1:8970 {
        header_up Remote-User owner
        header_up X-Mint-Gate {env.MINT_GATE_KEY}
    }
}
```

```sh
tailscale serve 8971
```

Set `MINT_USER=owner` and `MINT_ORIGIN=https://<device>.<tailnet>.ts.net`. Anyone who can reach the Serve address, or run a local process, gets past the gateway. Limit that with your tailnet access rules and keep the passkey lock on. Do not use Tailscale Funnel: it publishes the address to the internet with no login. The maintainer has not tested this; the commands follow Tailscale's own docs.

## Cloudflare Tunnel

A tunnel gets traffic to your machine but does not log anyone in. `cloudflared` cannot add `Remote-User` or `X-Mint-Gate`, and a bare tunnel is open to the internet. If you use one, put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/) in front of the host name so that only you can reach it, and point the tunnel at the same small Caddy as above:

```yaml
# ~/.cloudflared/config.yml
tunnel: <Tunnel-UUID>
credentials-file: /home/<you>/.cloudflared/<Tunnel-UUID>.json
ingress:
  - hostname: mint.example.com
    service: http://127.0.0.1:8971
  - service: http_status:404
```

```sh
cloudflared tunnel login
cloudflared tunnel create mint
cloudflared tunnel route dns mint mint.example.com
cloudflared tunnel run mint
```

Commands and config follow Cloudflare's [tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/). Without Access or something equivalent in front, do not do this: the Caddy above hard-codes your identity for whoever arrives. The maintainer has not tested this.

## Timezone

Mint uses one timezone, set by `MINT_TZ` in `.env` (an IANA name: `Australia/Sydney`, `Australia/Melbourne`, `Australia/Adelaide`, `Australia/Brisbane`, `Australia/Perth`). The default is `Australia/Perth`, so an install that sets nothing behaves as it always has. Every day boundary follows the zone: what counts as today, pay cycle start and end, the financial year (1 July in that zone), the 02:40 nightly reconcile, alert dates and the dates in exported files. The browser formats dates in the same zone, not the phone's or laptop's, so a trip abroad does not move your day. Daylight saving needs nothing from you: a 23 or 25 hour day counts as one day, and the reconcile runs once on both changeover days.

A misspelt or unknown name (including a plain offset such as `+10:00`, which has no daylight saving rules) stops Mint at start with a message that names `MINT_TZ`. `node scripts/check-env.mjs` checks it too.

Set it before the first sync. Mint stores each transaction's date as plain `YYYY-MM-DD` text, worked out in the zone at the time, and never rewrites history. Changing `MINT_TZ` later changes only how new days are bucketed. A transaction that sat just either side of midnight keeps the date it already has, and a cycle that straddles the change can look a day out once. Restart after you change it.

## Keeping it running

A systemd user unit does the job:

```ini
# ~/.config/systemd/user/mint.service
[Service]
WorkingDirectory=%h/mint
ExecStart=/usr/bin/node server.mjs
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now mint
loginctl enable-linger "$USER"
```

Run `node scripts/backup.mjs` daily from a timer. See [Backup and restore](#backup-and-restore).

## Docker

The repository ships a `Dockerfile` and a `docker-compose.yml`. The image is `node:22-alpine` plus the source: no npm install and no build step. Compose pulls `ghcr.io/kd-011/mint:latest` when it can and builds from your checkout when it cannot. It runs as the unprivileged `node` user, keeps its data in the `/data` volume and has a healthcheck on `/healthz`.

Demo, with invented data and no Redbark key:

```sh
docker compose up
```

Open <http://127.0.0.1:8980/>. It is published on the host's loopback only, and `docker compose down` throws the data away.

Your own book, on this machine only, with no login proxy:

```sh
MINT_TZ=Australia/Sydney docker compose --profile local up -d local
```

Open <http://127.0.0.1:8981/>. The book is in the `mint-data` volume. It survives a stop, a restart and an upgrade, and only `down -v` deletes it. Without Docker, `node scripts/local.mjs` does the same with the book in `data/`.

Local mode runs the real server behind a small front (`lib/localfront.mjs`) that adds the gateway headers for you. The front only answers requests addressed to `127.0.0.1` or `localhost`, so another website or a rebound DNS name gets a 403, and the fingerprint lock is off. Anyone with an account on the machine can open that port, so use it on a machine that is yours. For a phone, move to a login proxy: stop `local` and start `mint` as below. Both use the same volume, so the book comes with you. Run one or the other.

Back it up with `docker compose --profile local exec local node scripts/backup.mjs`, which writes a snapshot under `/data/backups`. Copy it out with `docker compose --profile local cp local:/data/backups ./mint-backups`.

Your own book behind a login proxy:

```sh
cp .env.example .env
chmod 600 .env
# fill in MINT_GATE_KEY, MINT_USER and MINT_ORIGIN (REDBARK_API_KEY only if you use Redbark)
docker compose --profile real up -d mint
```

This publishes `127.0.0.1:8970` and stores the database in the `mint-data` volume. The login proxy (above) runs on the host or in another container and must be the only way in. Inside the container Mint binds `0.0.0.0` (that is what `MINT_HOST` is for; leave it alone outside Docker), so do not change the `127.0.0.1:` prefix on the published port.

Back up the volume like any database: `docker compose exec mint node scripts/backup.mjs` writes a consistent snapshot under `/data/backups`.

## Updating

Schema changes are additive and Mint migrates on start. Take a backup first, then pull the new version and restart:

```sh
node scripts/backup.mjs
git pull
systemctl --user restart mint     # or: docker compose --profile real up -d --build mint
```

With local mode, `git pull`, then `docker compose --profile local up -d --build local`. `--build` makes the image from your checkout, so it always matches what you pulled.

Read the release notes before a minor version bump.

## Configuration

Everything is an environment variable, read from `.env` next to `server.mjs` or from the real environment. `.env.example` lists every one with a comment. The ones you will touch:

| Variable | What it does |
| --- | --- |
| `REDBARK_API_KEY` | Optional. Your Redbark key. Unset, there is no bank feed: manual accounts and CSV import only. |
| `MINT_GATE_KEY` | Required. Shared secret your proxy sends as `X-Mint-Gate` (32+ characters). |
| `MINT_TZ` | Your timezone as an IANA name, for example `Australia/Sydney`. Default `Australia/Perth`. See [Timezone](#timezone). |
| `MINT_USER` | Login name your proxy sends as `Remote-User`. Default `owner`. |
| `MINT_ORIGIN` | The https origin you serve Mint from. Default `http://localhost:<port>`. |
| `MINT_PORT` | Listen port on 127.0.0.1. Default 8970. |
| `MINT_HOME` | Folder for `data/`, `backups/` and `.env`. Default: the code folder. |
| `MINT_LOCK` | `off` disables the fingerprint lock, until a fingerprint is enrolled. |
| `OPENROUTER_API_KEY` | Optional. Lets a model categorise merchants Mint cannot place. See the [FAQ](faq.md#what-does-the-ai-categoriser-send) for what is sent. |
| `WISE_API_TOKEN`, `ALPHAVANTAGE_API_KEY` | Optional. Wise balances, US share prices. |
| `MINT_BACKUP_*` | Optional. Encrypted off-box backups. |

## Backup and restore

Your data is `data/mint.db` plus `data/receipts/`.

- `node scripts/backup.mjs` writes a consistent snapshot to `backups/mint-<date>.db` and keeps the newest 14. Run it daily from cron or a systemd timer.
- Set `MINT_BACKUP_HOST` (an ssh host from `~/.ssh/config`) and `MINT_BACKUP_AGE_RECIPIENT` (an [age](https://age-encryption.org) public key) and the same script also copies a gzipped, age-encrypted snapshot and an encrypted receipts mirror there. Keep the private key off the same disk.
- `node scripts/restore-test.mjs` pulls the newest off-box copy, decrypts it, checks integrity and compares row counts.
- To restore: stop Mint, copy a snapshot over `data/mint.db`, delete any `mint.db-wal` and `mint.db-shm` beside it, start Mint. If you lose your phone or passkey, `node scripts/lock-reset.mjs --yes` clears the enrolled fingerprints.
