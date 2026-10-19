# Backend Oracle Cloud par (Hinglish, phone se)

Yeh guide Render ki jagah Oracle Cloud ka VM use karne ke liye hai. Dashboard phir bhi Vercel par rehta hai (`docs/SUBAH_DEPLOY_HINGLISH.md`, Step C). Is guide ka matlab sirf **Step A (Neon) aur Step B (Render) ki jagah** hai: Oracle VM par database bhi usi VM par chalta hai, to Neon ki zaroorat nahi.

**Kya verify hua aur kya nahi (zaroor padho):**
- Verify hua: `deploy/oracle/setup.sh` ka dry-run (galat password/secret rok deta hai, secrets ek baar bante hain aur dobara chalane par nahi badalte, `.env` ki permission 600), `docker-compose.yml` valid hai, aur jo `.env` banta hai use asli server config production mode me accept karta hai (`apps/server/test/deploy-oracle.test.ts`). Dockerfile GitHub CI par sach me build hua aur container ka health check pass hua (amd64). `deploy/oracle/update.sh` ek local git repository aur nakli `docker` ke saath chalayi gayi (`apps/server/test/deploy-update.test.ts`): pull, rebuild, health ka intezaar, local badlav par inkaar, dry run, log me secrets chhupe.
- **Verify NAHI hua:** asli Oracle VM par first boot aur asli VM par `update.sh`, Oracle console ke menu/button ke naam (yaad se likhe hain, thode alag ho sakte hain), Let's Encrypt certificate `sslip.io` naam par, ARM (Ampere A1) par build, Docker ka `get.docker.com` install us VM par. Pehli baar chalane par kuch atak sakta hai: "Agar kuch na chale" section dekho.

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

Phir Deployments → latest → **Redeploy**. Ab `https://crypto-algo.vercel.app/login` par `admin` aur apna `ADMIN_PASSWORD` se login karo. Demo mode chalega (LIVE TRADING DISABLED): saaf dashboard khulega jisme ETH ka bada price, live chart, order flow (khareedaar baayein hare, bechne wale daayein laal), simulated account aur algo kya kar raha hai woh dikhta hai. Price aapka browser seedha Delta ke public feed se leta hai; agar woh na mile to price pe "Delayed" likha aata hai aur backend ka price dikhta hai. Purane technical tabs ke liye upar **Menu → Developer view**.

## Delta ke liye fixed IP (sirf Live ke waqt)

Delta API key (Trading permission) ke liye IP whitelist hota hai. Whitelist me **is VM ka public IP** daalna hai. Oracle ka "ephemeral" IP VM ke saath rehta hai jab tak VM delete na ho, par pakka karne ke liye **Networking → IP management → Reserved public IPs** me IP reserve karke VM ke VNIC se jodo. **IP badalne par** `sslip.io` ka naam bhi badal jata hai: tab `BACKEND_URL` Vercel me badlo, aur VM par `setup.sh` dobara chalao (Cloud Shell se ssh karke, neeche dekho).

## Dhyan do (Oracle ki shartein)

- **Idle Always Free VM reclaim ho sakti hai.** Oracle ki policy (yaad se, current rules check karo): agar Always Free VM kai din tak bahut kam use ho (CPU/network low), to Oracle use band ya reclaim kar sakta hai. Bot kam CPU leta hai, to risk hai. Account ko **Pay As You Go** par upgrade karne se (Always Free limits ke andar kharcha $0 rehta hai) ye risk hat jata hai: ek baar check karo.
- Secrets cloud-init script me hain, jo Oracle ke instance metadata me store hota hai (aapka console account aur VM ke andar root dekh sakte hain). Is page ko kisi ke saath share mat karo.
- Backup: database VM ki disk par hai, alag backup nahi. Zaroorat ho to Oracle me boot volume backup lagao.
- Ye ek hi VM hai: VM band to bot band. Khula real position ho to Live me exchange-side stop order Delta par rehta hai, par phir bhi Live tabhi chalao jab upar ki baatein samajh aa gayi hon.

## Timeout hai to firewall check karo

`ERR_CONNECTION_TIMED_OUT` ka matlab hai ki request VM tak pahunchi hi nahi (agar VM tak pahunchti aur Caddy na chalta to turant "refused" aata). Sabse common wajah: Ingress rules galat jagah lage. Check karo:

1. Laptop par (PowerShell): `Test-NetConnection <VM-IP> -Port 22`, phir `-Port 80`, phir `-Port 443`. (Mac/Linux: `nc -vz -w 5 <VM-IP> 22` aise hi 80, 443.) Port 22 khula ho aur 80/443 nahi, to wajah Security List/NSG hai. Teeno band hon to wajah route/Internet Gateway ya VM ka public IP hai.
2. Oracle Console: Instance -> **Networking** tab -> Primary VNIC: **Subnet** aur **Network security groups** dekho. Agar VCN purani hai (maslan kisi pehle project ki), to uske subnet par default se alag Security List lagi ho sakti hai: **us subnet ke saath attached har Security List** ke Ingress Rules me `0.0.0.0/0  TCP  80` aur `443` hone chahiye. Agar VNIC par NSG lagi hai to uske Ingress me bhi.
3. Rule me **Source Type = CIDR, Source CIDR = 0.0.0.0/0, IP Protocol = TCP, Destination Port Range = 80** (443 ke liye alag rule). "Source Port Range" khali chhodo.
4. Subnet **Public** hona chahiye aur uske Route Table me `0.0.0.0/0 -> Internet Gateway` hona chahiye.
5. Rules lagne ke baad bhi na chale to doosre network se try karo (phone ka mobile data): kabhi office/college ka network 443 par outbound rok deta hai.

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
| Browser me `ERR_CONNECTION_TIMED_OUT` | Packets Oracle ke firewall par gir rahe hain: port 80/443 ka Ingress rule us subnet par lagta hi nahi. Neeche "Timeout hai to firewall check karo" dekho |
| `/api/health` certificate error | Certificate abhi ban raha hai: 5 minute ruko |
| setup log me "NOT healthy after 10 minutes" | `docker compose ... logs server caddy` dekho; screenshot bhejo |
| Docker build me "Killed" | RAM kam: swap bana ya nahi dekho (`free -m`); ya A1.Flex shape lo |
| `/api/health` theek, par Vercel login me "backend unreachable" | Vercel `BACKEND_URL` galat/old, ya Redeploy nahi hua |
| Login me galat password | `ADMIN_PASSWORD` wahi jo script me tha. Badalna ho to `setup.sh` dobara chalao nayi value ke saath |

## Naya version lagana / band karna

### Backend update: ek hi command

Jab `main` branch par naya code aaye to **dashboard (Vercel) apne aap update ho jata hai**, uske liye kuch nahi karna. Sirf backend (VM) ko update karna padta hai, aur uske liye ek command kaafi hai. Koi password ya secret type nahi karna: script wahi `.env` use karti hai jo pehli baar `setup.sh` ne banayi thi.

Phone se: Oracle console me upar **Cloud Shell** (`>_`) kholo (private key pehle jaise upload karo), phir:

```
chmod 600 ~/<key-file>
ssh -i ~/<key-file> ubuntu@<VM-IP> "sudo bash /opt/cryptoalgo/deploy/oracle/update.sh"
```

VM ke andar ho to bas: `sudo bash /opt/cryptoalgo/deploy/oracle/update.sh`

Script ye kaam is order me karti hai:
1. Check karti hai ki koi dusra update to nahi chal raha, aur VM par kisi file me haath se badlav to nahi hai. Badlav mila to file ke naam dikhakar ruk jati hai, kuch badalti nahi.
2. Naya code leti hai (`git pull`, sirf aage badhne wala).
3. Naya docker image banati hai aur restart karti hai. Isme kuch minute lagte hain, 1 GB wali VM par 10-20 minute bhi.
4. 5 minute tak backend ke health check ka intezaar karti hai.

Aakhir me kya likha aata hai:

| Dikha | Matlab / kya karo |
|---|---|
| `OK: the backend runs <commit> and is healthy` | Update ho gaya. `https://<naam>.sslip.io/api/health` me `ok:true` dekh sakte ho. |
| `NOT healthy after 300s` aur 40 log lines | Naya version theek se start nahi hua. Log lines ka screenshot developer ko bhejo. Script khud purane commit par wapas jaane ka command bhi likh deti hai (secrets log me `***` se chhupe hote hain). |
| `the working tree ... has local changes` | VM par kisi file me haath se badlav hua hai, isliye script ruk gayi. Kuch badla nahi gaya. Developer se poochho. |
| `git pull --ff-only failed` | Network nahi, ya history alag ho gayi. Purana version chalta rahega. |
| `another update is already running` | Pehla update khatam hone do. |

Pehle sirf check karna ho (kuch badalta nahi): `sudo DRY_RUN=1 bash /opt/cryptoalgo/deploy/oracle/update.sh`

### Update ke baad kya badalta hai (settings version 2)

Naye backend ke **pehle start par** saved settings ek baar apne aap upgrade hoti hain (audit log me ek `settings_migrated` entry banti hai):
- Position par **koi time limit nahi** (pehle 30 minute tha). Trade ghanton chal sakta hai, raat bhar bhi, aur funding payments beech me aati hain. Stop-loss hamesha lagi rehti hai.
- Target fixed **$10 per ETH**, stop **$5 se $8** ke beech.
- Closing-fee waiver (Scalper Offer) band: brokerage entry aur exit **dono** par lagti hai (0.20 ETH par lagbhag $0.80, ETH ~$3,390 par).
- Roz ka goal 500 INR sirf dikhane ke liye. Yeh goal hai, vaada nahi, aur bot goal poora karne ke liye trade nahi karta.
- Baaki sab (quantity, leverage, risk limits, filters, INR rate...) jaisa tha waisa hi rehta hai. Agar aapne target ya stop haath se badle the to Developer view → Strategy & Risk me dobara set karo.

Dhyan do: update tab karo jab koi trade khula na ho (to behtar). Ek hi database par purana aur naya backend ek saath mat chalao (jaise Render aur Oracle dono). Is VM par purana container naye se badal jata hai, to koi dikkat nahi.

### Band karna, aur `setup.sh` kab

```
cd /opt/cryptoalgo/deploy/oracle && sudo docker compose down        # band (data rehta hai); "up -d" se wapas
```

`setup.sh` sirf pehli install ke liye hai, ya jab `ADMIN_PASSWORD`, `PROXY_SHARED_SECRET` ya IP badalna ho (upar ke tables me bataya hai). Normal update me iski zaroorat nahi.

Database ka backup: `sudo docker compose -f /opt/cryptoalgo/deploy/oracle/docker-compose.yml exec db pg_dump -U cryptoalgo cryptoalgo > backup.sql`.
