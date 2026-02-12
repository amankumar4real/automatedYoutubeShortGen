# Stable URL with Cloudflare Named Tunnel (Option A)

This gives you a **fixed URL** that does not change when the tunnel restarts (unlike the random `trycloudflare.com` URL).

You need a **domain** in your Cloudflare account. Use one you already own, or register a free one (e.g. [Freenom](https://www.freenom.com) for `.tk`/`.ml`) or a cheap one, then add it to Cloudflare.

---

## 1. Cloudflare account and domain

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up) (free).
2. Add your domain:
   - **If you own a domain:** In the dashboard, **Add site** → enter the domain → follow the steps (update nameservers at your registrar to Cloudflare’s).
   - **If you need a free domain:** Register e.g. `myname.tk` at Freenom, then in Cloudflare click **Add site** and enter that domain; set Freenom nameservers to the ones Cloudflare shows.

---

## 2. Create a Named Tunnel

1. In Cloudflare Dashboard go to **Zero Trust** (or open [one.dash.cloudflare.com](https://one.dash.cloudflare.com)).
2. If asked, create a **team** (free); choose any team name.
3. Go to **Networks** → **Tunnels** → **Create a tunnel**.
4. Choose **Cloudflared** → name the tunnel (e.g. `shorts-app`) → **Save tunnel**.
5. On **Install connector**:
   - Choose **Docker**.
   - Copy the command shown (it contains a **token**). It looks like:
     ```bash
     docker run cloudflared cloudflared tunnel run --token <long-token>
     ```
   - **Do not run that yet** — we’ll use the token in Docker Compose.
6. Under **Public Hostname** (same page or **Configure** tab):
   - Click **Add a public hostname**.
   - **Subdomain:** e.g. `shorts` (or any name you like).
   - **Domain:** select your domain (e.g. `yourdomain.tk`). The URL will be `https://shorts.yourdomain.tk`.
   - **Service type:** HTTP.
   - **URL:** Enter **Hostname** `web` and **Port** `80` (so **http://web:80**).  
     Our tunnel runs in Docker and forwards to the `web` service. If the dashboard has a single “URL” field, try `http://web:80`; if it only has “localhost”, some setups let you change it to the service name `web`.
   - **Save**.
7. Copy the **tunnel token** from the Docker install step (the long string after `--token`). You’ll put it in `.env` on the server.

---

## 3. Server: use the token

1. On the server, in the project directory:
   ```bash
   cd ~/serverFiles/automatedYoutubeShortGen   # or your path
   nano .env
   ```
2. Add (replace with your token):
   ```env
   TUNNEL_TOKEN=your-long-token-from-cloudflare
   ```
3. Restart the stack so the tunnel uses the named tunnel instead of the quick tunnel:
   ```bash
   docker compose down
   docker compose up -d
   ```
4. Your app is now at the **stable URL** you set (e.g. `https://shorts.yourdomain.tk`). Use that in the frontend; it will not change on restart.

---

## 4. If you don’t have a domain

- **Free:** Register a free domain (e.g. at Freenom) and add it to Cloudflare as above.
- **Paid:** Buy a cheap domain (~$1–10/year) and add it to Cloudflare.

Without a domain in Cloudflare you cannot assign a public hostname; the named tunnel only gives a stable internal target (e.g. `<uuid>.cfargotunnel.com`), not a URL you can hand out.
