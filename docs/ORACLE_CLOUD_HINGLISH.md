# Backend Oracle Cloud par (Hinglish, phone se)

Yeh guide Render ki jagah Oracle Cloud ka VM use karne ke liye hai. Dashboard phir bhi Vercel par rehta hai (`docs/SUBAH_DEPLOY_HINGLISH.md`, Step C). Is guide ka matlab sirf **Step A (Neon) aur Step B (Render) ki jagah** hai: Oracle VM par database bhi usi VM par chalta hai, to Neon ki zaroorat nahi.

**Kya verify hua aur kya nahi (zaroor padho):**
- Verify hua: `deploy/oracle/setup.sh` ka dry-run (galat password/secret rok deta hai, secrets ek baar bante hain aur dobara chalane par nahi badalte, `.env` ki permission 600), `docker-compose.yml` valid hai, aur jo `.env` banta hai use asli server config production mode me accept karta hai (`apps/server/test/deploy-oracle.test.ts`). Dockerfile GitHub CI par sach me build hua aur container ka health check pass hua (amd64).
- **Verify NAHI hua:** asli Oracle VM par first boot, Oracle console ke menu/button ke naam (yaad se likhe hain, thode alag ho sakte hain), Let's Encrypt certificate `sslip.io` naam par, ARM (Ampere A1) par build, Docker ka `get.docker.com` install us VM par. Pehli baar chalane par kuch atak sakta hai: "Agar kuch na chale" section dekho.

## Kya milega

Ek VM par teen container: Postgres (database), bot + API, aur Caddy (HTTPS). Bot ko Delta API key abhi nahi chahiye (Demo public market data se chalta hai). Live ke liye key baad me, dashboard se, aur tab tak Live band rehta hai.

HTTPS isliye zaroori hai ki Vercel `BACKEND_URL` ko https hi lega. Domain nahi hai to script `sslip.io` ka naam use karta hai: IP `129.146.10.20` ho to naam `129-146-10-20.sslip.io` bana, aur Caddy apne aap free certificate leta hai.

## Step 1: Do secrets socho (phone ke password manager me)

Sirf letters, digits aur `. _ @ % + = : , -` (space, quote, `#`, `$` nahi):
- `ADMIN_PASSWORD`: kam se kam 12 characters. Dashboard login (user `admin`) me yahi lagega.
- `PROXY_SHARED_SECRET`: kam se kam 32 characters, random (password manager se 40 letters+digits generate karo). Yahi value Vercel me bhi daalni hai.

## Step 2: VM banao

1. cloud.oracle.com par login. Menu (3 lines) me **Compute → Instances → Create instance**.
2. Name `cryptoalgo`. **Image:** "Change image" → **Canonical Ubuntu 22.04** (ya 24.04).
3. **Shape:** "Change shape". Always Free wala chuno: `VM.Standard.E2.1.Micro` (AMD, 1 GB RAM; script 2 GB swap khud jod deta hai) ya `VM.Standard.A1.Flex` (ARM, zyada RAM; kabhi "out of capacity" aata hai, to baad me try karo). A1 par image build maine test nahi ki.
4. **Networking:** default VCN/subnet, **"Assign a public IPv4 address" ON**.
5. **SSH keys:** "Generate a key pair for me" dabao aur **private key download karke safe rakho** (agar kuch atak jaye to debug ke kaam aati hai). Bina key ke bhi VM chalegi, par tab andar jaakar kuch dekh nahi paoge.
6. **Advanced options → Management** (ya "Show advanced options") me **Cloud-init script → "Paste cloud-init script"**.
7. Dusre tab me ye file kholo aur poora copy karo: `https://raw.githubusercontent.com/vikrantsingh07-ai/Crypto-Algo/main/deploy/oracle/user-data.sh`. Oracle ke box me paste karo. **Sirf upar ki do lines badlo:** `ADMIN_PASSWORD='...'` aur `PROXY_SHARED_SECRET='...'` me apni values daalo (quotes rehne do). `CHANGE_ME` bacha to script ruk jayegi.
8. **Create** dabao. Status "Running" hone tak ruko. Instance page par **Public IP address** note karo (jaise `129.146.10.20`).

## Step 3: Port 80 aur 443 kholo (Oracle ka firewall)

Oracle default me sirf port 22 kholta hai. Bina iske HTTPS nahi aayega.
1. Instance page → **Subnet** par tap karo → us subnet ke **Security Lists** me default list kholo.
2. **Add Ingress Rules**: Source CIDR `0.0.0.0/0`, IP Protocol TCP, Destination Port Range `80`. Save.
3. Dobara Add: wahi, port `443`. Save.

## Step 4: Intezaar aur check

Pehli baar image build me **10 se 20 minute** lag sakte hain (1 GB wali VM par zyada). Phir browser me kholo:

`https://<IP me dots ki jagah dash>.sslip.io/api/health` (jaise `https://129-146-10-20.sslip.io/api/health`)

`{"ok":true, ...}` jaisa JSON dikhe to backend chal raha hai. Certificate pehli baar thoda late aa sakta hai: 2-3 minute baad dobara kholo.

## Step 5: Vercel se jodo

Vercel project → Settings → Environment Variables:
- `BACKEND_URL` = `https://129-146-10-20.sslip.io` (apna naam; https se shuru, end me `/` nahi)
- `PROXY_SHARED_SECRET` = Step 1 wali **wahi** value

Phir Deployments → latest → **Redeploy**. Ab `https://crypto-algo.vercel.app/login` par `admin` aur apna `ADMIN_PASSWORD` se login karo. Demo mode chalega (LIVE TRADING DISABLED).

## Delta ke liye fixed IP (sirf Live ke waqt)

Delta API key (Trading permission) ke liye IP whitelist hota hai. Whitelist me **is VM ka public IP** daalna hai. Oracle ka "ephemeral" IP VM ke saath rehta hai jab tak VM delete na ho, par pakka karne ke liye **Networking → IP management → Reserved public IPs** me IP reserve karke VM ke VNIC se jodo. **IP badalne par** `sslip.io` ka naam bhi badal jata hai: tab `BACKEND_URL` Vercel me badlo, aur VM par `setup.sh` dobara chalao (Cloud Shell se ssh karke, neeche dekho).

## Dhyan do (Oracle ki shartein)

- **Idle Always Free VM reclaim ho sakti hai.** Oracle ki policy (yaad se, current rules check karo): agar Always Free VM kai din tak bahut kam use ho (CPU/network low), to Oracle use band ya reclaim kar sakta hai. Bot kam CPU leta hai, to risk hai. Account ko **Pay As You Go** par upgrade karne se (Always Free limits ke andar kharcha $0 rehta hai) ye risk hat jata hai: ek baar check karo.
- Secrets cloud-init script me hain, jo Oracle ke instance metadata me store hota hai (aapka console account aur VM ke andar root dekh sakte hain). Is page ko kisi ke saath share mat karo.
- Backup: database VM ki disk par hai, alag backup nahi. Zaroorat ho to Oracle me boot volume backup lagao.
- Ye ek hi VM hai: VM band to bot band. Khula real position ho to Live me exchange-side stop order Delta par rehta hai, par phir bhi Live tabhi chalao jab upar ki baatein samajh aa gayi hon.

## Agar kuch na chale

VM ke andar dekhne ke liye (SSH key chahiye jo Step 2 me download ki): Oracle console me upar **Cloud Shell** (`>_`) kholo, menu se private key upload karo, phir:

```
chmod 600 ~/<key-file>
ssh -i ~/<key-file> ubuntu@<VM-IP>
sudo tail -80 /var/log/cryptoalgo-setup.log      # setup ka log
sudo docker compose -f /opt/cryptoalgo/deploy/oracle/docker-compose.yml ps
sudo docker compose -f /opt/cryptoalgo/deploy/oracle/docker-compose.yml logs --tail 60 server caddy
cat /opt/cryptoalgo/STATUS.txt                   # BACKEND_URL wagairah (secrets nahi)
```

| Dikha | Matlab / kya karo |
|---|---|
| log me `CHANGE_ME` ya `must be at least` | Script ki do lines theek nahi thi. VM delete karke naye script se banao (ya ssh karke `ADMIN_PASSWORD=... PROXY_SHARED_SECRET=... sudo -E bash /opt/cryptoalgo/deploy/oracle/setup.sh` dobara chalao) |
| `/api/health` timeout / certificate error | Step 3 (port 80 aur 443) nahi khule, ya certificate abhi ban raha hai. 5 minute ruko |
| setup log me "NOT healthy after 10 minutes" | `docker compose ... logs server caddy` dekho; screenshot bhejo |
| Docker build me "Killed" | RAM kam: swap bana ya nahi dekho (`free -m`); ya A1.Flex shape lo |
| `/api/health` theek, par Vercel login me "backend unreachable" | Vercel `BACKEND_URL` galat/old, ya Redeploy nahi hua |
| Login me galat password | `ADMIN_PASSWORD` wahi jo script me tha. Badalna ho to `setup.sh` dobara chalao nayi value ke saath |

## Naya version lagana / band karna

```
cd /opt/cryptoalgo && sudo git pull --ff-only
sudo ADMIN_PASSWORD=... PROXY_SHARED_SECRET=... bash deploy/oracle/setup.sh   # rebuild + restart, secrets wahi rehte hain
cd deploy/oracle && sudo docker compose down        # band (data rehta hai); "up -d" se wapas
```

Database ka backup: `sudo docker compose -f /opt/cryptoalgo/deploy/oracle/docker-compose.yml exec db pg_dump -U cryptoalgo cryptoalgo > backup.sql`.
