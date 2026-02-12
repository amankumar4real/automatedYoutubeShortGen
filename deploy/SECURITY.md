# Server security checklist

Goal: **`sudo ss -tulpn`** shows only **SSH on 2222** and **nginx on 80 / 443**. No Mongo, no worker/API, no ffmpeg or automation ports exposed.

---

## 1. Do not run containers as root

- **API:** The app image runs as `USER node` (non-root).
- **Web (nginx):** `nginx:alpine` runs as the `nginx` user.
- **Mongo:** Official image runs as root; we use `security_opt: no-new-privileges:true` to limit privilege escalation.
- **Tunnel:** `no-new-privileges:true` set.

---

## 2. Protect Docker socket

- **No service** in `docker-compose.yml` mounts `/var/run/docker.sock`.
- Do not add the socket to any container unless strictly required, and then restrict access (e.g. read-only, dedicated proxy).

---

## 3. Everything behind Nginx

- Only the **web** (nginx) container has published ports: **80** and **443**.
- All API, health, and frontend traffic goes through nginx; the API is not published on the host.

---

## 4. Do not expose Mongo

- **Mongo** has **no** `ports:` in compose. It is reachable only by the API over the Docker network (`mongo:27017`).
- To use `mongosh` from the host, run:  
  `docker exec -it shorts-mongo mongosh -u USER -p PASS --authenticationDatabase admin`

---

## 5. Do not expose worker / ffmpeg / automation

- **API** has **no** published ports. The pipeline (ffmpeg, automation) runs inside the API container; only nginx talks to the API on the internal network.

---

## 6. Only SSH (2222) and Nginx (80/443) on the host

### 6.1 Move SSH to port 2222 (on the server)

```bash
# Edit SSH config
sudo nano /etc/ssh/sshd_config
# Set: Port 2222
# Save, then:
sudo systemctl reload sshd
```

Before disconnecting, test in a **new** terminal: `ssh -p 2222 root@YOUR_SERVER`. Then close the old session.

### 6.2 Firewall: allow only 2222, 80, 443

```bash
# UFW (Ubuntu/Debian)
sudo ufw default deny incoming
sudo ufw allow 2222/tcp   # SSH
sudo ufw allow 80/tcp     # HTTP
sudo ufw allow 443/tcp    # HTTPS
sudo ufw enable
sudo ufw status
```

### 6.3 Verify listeners

```bash
sudo ss -tulpn
```

You should see only:

- **2222** — sshd (or your SSH daemon)
- **80**  — nginx (or docker-proxy for 80)
- **443** — nginx (or docker-proxy for 443)

No 27017 (Mongo), no 4000 (API).

---

## 7. Optional: HTTPS on 443

1. Install certbot and get a cert (e.g. Let’s Encrypt):  
   `sudo apt install certbot` then `sudo certbot certonly --standalone -d yourdomain.com`
2. Mount the certs into the **web** container and add a `listen 443 ssl` server block in `deploy/nginx.conf` with `ssl_certificate` and `ssl_certificate_key`.
3. Restart: `docker compose up -d web`.

---

## Quick reference

| Item              | Action |
|-------------------|--------|
| Containers as root | API runs as `node`; nginx as `nginx`; others use `no-new-privileges` |
| Docker socket     | Not mounted in any service |
| Nginx             | Only service with host ports: 80, 443 |
| Mongo             | No host port; internal only |
| API / worker      | No host port; internal only |
| SSH               | Use port 2222 and firewall |
