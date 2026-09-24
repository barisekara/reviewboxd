# Deploying reviewboxd

This guide deploys reviewboxd on an Ubuntu server with Docker, behind Cloudflare.
Commands prefixed with `local$` run on your own computer; `server$` means on the server over SSH.

**What you need:**

- An Ubuntu server (22.04 or 24.04) you can reach with `ssh`
- A domain whose DNS is managed by Cloudflare. This guide uses `reviewboxd.example.com`;
  replace it with yours.

**How it fits together:**

```
visitor ──HTTPS──▶ Cloudflare ──▶ (tunnel or reverse proxy) ──▶ reviewboxd container on 127.0.0.1:3000
```

The container only listens on `127.0.0.1`, so it's never exposed directly. HTTPS is handled by
Cloudflare, through either a Cloudflare Tunnel (option A, recommended) or a reverse proxy
already running on the server (option B).

---

## 1. Connect to the server

```sh
local$ ssh ubuntu@your-server-ip
```

Check the Ubuntu version and whether Docker is already installed:

```sh
server$ lsb_release -ds
server$ docker --version
```

If Docker prints a version, skip to step 3.

## 2. Install Docker

These are Docker's official install steps for Ubuntu:

```sh
server$ sudo apt-get update
server$ sudo apt-get install -y ca-certificates curl git
server$ sudo install -m 0755 -d /etc/apt/keyrings
server$ sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
server$ sudo chmod a+r /etc/apt/keyrings/docker.asc
server$ echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
server$ sudo apt-get update
server$ sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Let your user run Docker without `sudo`, then log out and back in so it takes effect:

```sh
server$ sudo usermod -aG docker $USER
server$ exit
local$  ssh ubuntu@your-server-ip
server$ docker run --rm hello-world   # should print "Hello from Docker!"
```

## 3. Get the code

```sh
server$ sudo mkdir -p /opt/reviewboxd && sudo chown $USER: /opt/reviewboxd
server$ git clone https://github.com/barisekara/reviewboxd.git /opt/reviewboxd
server$ cd /opt/reviewboxd
```

## 4. Configure

```sh
server$ cp .env.example .env
server$ nano .env
```

Set at least:

| Variable | Value |
|---|---|
| `BMC_USERNAME` | your Buy Me a Coffee username, or empty to hide the tile |
| `GITHUB_SPONSORS_USERNAME` | your GitHub Sponsors username, or empty to hide the tile |
| `POSTER_SOURCE` / `TMDB_API_KEY` | only if you want TMDB images |
| `HOST_PORT` | `3000`, or another port if 3000 is taken on the server |

`.env` stays on the server; it's in `.gitignore`, so `git pull` never touches it.

## 5. Start the app

```sh
server$ docker compose up -d --build
server$ docker compose ps          # STATUS should become "healthy" within ~30 seconds
server$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/   # should print 200
```

Check that the server can reach Letterboxd:

```sh
server$ curl -s "http://127.0.0.1:3000/api/review?url=https://letterboxd.com/davidehrlich/film/barbie/" | head -c 200
```

You should see JSON starting with `{"url":...`. If you get the "Letterboxd isn't playing along"
error instead, see [Troubleshooting](#troubleshooting).

## 6. HTTPS through Cloudflare

Choose **one** option.

### Option A: Cloudflare Tunnel (recommended)

The server opens an outgoing connection to Cloudflare, so no ports need to be open and the
server's IP address stays hidden.

1. In the Cloudflare dashboard, go to **Zero Trust → Networks → Tunnels → Create a tunnel**.
2. Choose **Cloudflared**, name it `reviewboxd`, and save.
3. On the install screen, pick **Docker** and copy the token: the long string after `--token`.
   You don't need to run the command it shows.
4. Put the token in `.env` on the server:

   ```sh
   server$ nano .env    # CLOUDFLARE_TUNNEL_TOKEN=eyJ...
   ```

5. Start the app together with the tunnel:

   ```sh
   server$ docker compose --profile tunnel up -d
   ```

   Back in the dashboard, the tunnel should show as **Healthy** within a few seconds.
6. Still in the tunnel settings, add a **Public hostname**:
   - Subdomain and domain: `reviewboxd` / `example.com`
   - Service type **HTTP**, URL **`reviewboxd:3000`**
7. Open `https://reviewboxd.example.com`.

Cloudflare creates the DNS record for you. From now on, always include `--profile tunnel` in
`docker compose up` commands, or add `COMPOSE_PROFILES=tunnel` to `.env` so you can leave it out.

### Option B: a reverse proxy already on the server

Use this if the server already runs nginx or Caddy for other sites.

1. In Cloudflare DNS, add an `A` record `reviewboxd` pointing to the server's IP, with the orange
   cloud (proxied) on.
2. In Cloudflare, set **SSL/TLS → Overview** to **Full (strict)**.
3. Add a site to your proxy.

   **Caddy** (`/etc/caddy/Caddyfile`), which gets its own certificate automatically:

   ```
   reviewboxd.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   ```sh
   server$ sudo systemctl reload caddy
   ```

   **nginx** (`/etc/nginx/sites-available/reviewboxd`). Use a Cloudflare Origin Certificate
   (**SSL/TLS → Origin Server → Create certificate**) saved to the paths below:

   ```nginx
   server {
       listen 443 ssl;
       server_name reviewboxd.example.com;
       ssl_certificate     /etc/ssl/cloudflare/reviewboxd.pem;
       ssl_certificate_key /etc/ssl/cloudflare/reviewboxd.key;

       client_max_body_size 5m;   # share-card uploads are up to ~4 MB

       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-Proto https;
           proxy_set_header CF-IPCountry $http_cf_ipcountry;
       }
   }
   ```

   ```sh
   server$ sudo ln -s /etc/nginx/sites-available/reviewboxd /etc/nginx/sites-enabled/
   server$ sudo nginx -t && sudo systemctl reload nginx
   ```

The `Host` and `X-Forwarded-Proto` headers matter: share links are built from them, and without
them links would point to `http://127.0.0.1:3000`.

## 7. Cloudflare settings

- **Network → IP Geolocation: on.** It's on by default; it provides the country header used to
  pick the language.
- **Don't cache HTML.** Cloudflare doesn't cache HTML by default. Don't add a "Cache Everything"
  rule, or visitors would get each other's language.
- **Leave Web Analytics off.** The site promises "no analytics, no tracking".

## 8. Firewall (recommended)

```sh
server$ sudo ufw allow OpenSSH
server$ sudo ufw allow 80,443/tcp   # option B only; skip for option A
server$ sudo ufw enable
server$ sudo ufw status
```

Docker can bypass `ufw` for published ports. That's safe here because the container is published
on `127.0.0.1` only.

---

## Everyday tasks

**Deploy a new version**

```sh
local$  git push                     # from your computer
server$ cd /opt/reviewboxd && git pull && docker compose up -d --build
```

**Edit sponsors, taglines or sponsor logos:** edit `sponsors.json`, `taglines.json` or the files
in `public/sponsors/` on the server. No rebuild needed; refresh the page. If a change doesn't show
up, run `docker compose restart reviewboxd` (some editors save by replacing the file, which a
running container doesn't see).

**Change `.env`:** `docker compose up -d`. The container is recreated with the new values.

**Logs.** Every line starts with a timestamp. Page views, review lookups (with the review link
and the outcome, e.g. `code=rate_limited`), share-card creation, TMDB requests and responses
(API key masked) and errors are logged, but never IP addresses. Docker keeps up to ~50 MB, then rotates.

```sh
server$ docker compose logs -f --tail 200 reviewboxd        # follow, starting with the last 200 lines
server$ docker compose logs --since 1h reviewboxd           # everything from the last hour
server$ docker compose logs reviewboxd | grep code=         # only failed or limited lookups
```

**Rate limit.** Each visitor IP gets `RATE_LIMIT_PER_MINUTE` review lookups per minute (default 5).
Change it in `.env`, then run `docker compose up -d`. The limit relies on Cloudflare's
`CF-Connecting-IP` header, which the tunnel and reverse proxies pass through automatically.

**Back up saved share cards:** they live in the `reviewboxd_cards` Docker volume.

```sh
server$ docker run --rm -v reviewboxd_cards:/data -v "$PWD":/backup alpine \
  tar czf /backup/cards-$(date +%F).tar.gz -C /data .
```

**Delete old share cards** (older than 180 days, for example):

```sh
server$ docker compose exec reviewboxd find /app/data/cards -type f -mtime +180 -delete
```

**Stop everything:** `docker compose --profile tunnel down`. Saved cards stay in the volume.

---

## Troubleshooting

**"Letterboxd isn't playing along" for every review.** Letterboxd sits behind Cloudflare's bot
protection, and datacenter IP addresses get blocked more often than home connections. Check from
the server:

```sh
server$ curl -s -o /dev/null -w "%{http_code}\n" -A "Mozilla/5.0" https://letterboxd.com/davidehrlich/film/barbie/
```

`200` means reachable. `403` means the server's IP is blocked. Run `docker compose logs reviewboxd`
for the exact reason reviewboxd logged.

**Container isn't healthy.** Run `docker compose logs reviewboxd`. The usual cause is another program
on `HOST_PORT`; change it in `.env` and run `docker compose up -d`.

**Share links show the wrong address (`http://127.0.0.1:3000/c/...`).** The reverse proxy isn't
passing `Host` and `X-Forwarded-Proto`; see option B.

**Tunnel shows "Inactive" in Cloudflare.** Check that `CLOUDFLARE_TUNNEL_TOKEN` is set in `.env`,
and that you started with `--profile tunnel`. `docker compose logs cloudflared` shows the error.

**Wrong language.** Your choice in the footer is stored in a cookie. Clear it, or open the site with
`?lang=en` to reset it.
