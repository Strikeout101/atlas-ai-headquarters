# Claw-Empire Deployment Guide

This directory contains production deployment examples for a single-host Linux setup.

Included files:

- `deploy/.env.production.template`: runtime environment template
- `deploy/claw-empire@.service`: example user-level systemd service
- `deploy/nginx/claw-empire.conf`: example nginx reverse proxy

## Assumptions

- Node.js 22 or newer
- pnpm 9 or newer
- Linux with `systemd`
- Optional: nginx for TLS termination and reverse proxying

## 1. Build the app

```bash
git clone https://github.com/GreenSheep01201/claw-empire.git
cd claw-empire
pnpm install
pnpm run build
```

## 2. Create the runtime env file

```bash
cp deploy/.env.production.template deploy/.env.production
```

Set at minimum:

- `OAUTH_ENCRYPTION_SECRET`
- `INBOX_WEBHOOK_SECRET`
- `TRUSTED_NETWORKS` (optional): CIDRs whose browsers sign in automatically, such as your trusted VLANs. Everyone else gets a login screen; set its password in Settings > Security from the server machine or a trusted network. Requests relayed by nginx, Tailscale Serve, cloudflared, or the Vite dev proxy are judged by the client address the proxy reports, not by the proxy's own `127.0.0.1` connection.
- `ALLOWED_HOSTS` (optional): host names browsers use to reach ATLAS (IP addresses and `localhost` are always allowed).
- `API_AUTH_TOKEN` (optional) for scripts and integrations using `Authorization: Bearer`.
- `OAUTH_BASE_URL` if the public URL differs from `http://127.0.0.1:8790`

If you run behind nginx on the same host, keep:

- `HOST=127.0.0.1`
- `PORT=8790`

If you expose the Node server directly on a LAN or VPN, set `HOST=0.0.0.0` and review `ALLOWED_ORIGINS` or `ALLOWED_ORIGIN_SUFFIXES`.

## 3. Install the user service

```bash
mkdir -p ~/.config/systemd/user
cp deploy/claw-empire@.service ~/.config/systemd/user/claw-empire.service
systemctl --user daemon-reload
systemctl --user enable --now claw-empire
```

If you want the service to survive logout:

```bash
sudo loginctl enable-linger "$USER"
```

Useful commands:

```bash
systemctl --user status claw-empire
journalctl --user -u claw-empire -f
```

## 4. Optional nginx reverse proxy

```bash
sudo cp deploy/nginx/claw-empire.conf /etc/nginx/sites-available/claw-empire
sudo ln -s /etc/nginx/sites-available/claw-empire /etc/nginx/sites-enabled/claw-empire
sudo nginx -t
sudo systemctl reload nginx
```

Update `server_name` before enabling the site. If you use Let's Encrypt, install the certificate after the site is reachable.

## 5. Smoke checks

Local health check:

```bash
curl http://127.0.0.1:8790/api/health
```

Authenticated remote check:

```bash
curl -H "Authorization: Bearer YOUR_API_AUTH_TOKEN" https://claw.example.com/api/health
```

## 6. Updating

```bash
git pull
pnpm install
pnpm run build
systemctl --user restart claw-empire
```

## Notes

- `deploy/.env.production` is a local runtime file and should stay untracked.
- The service example writes logs to `./logs`.
- The template is intentionally conservative. Add provider-specific keys only if you use those integrations.
