# Subah Deploy Guide (Hinglish) - phone se, bina terminal ke

Yeh guide un operator ke liye hai jo sirf phone ka browser use kar raha hai: GitHub app, Vercel dashboard aur backend host ka dashboard. Koi terminal, CLI ya laptop nahi chahiye.

Likha gaya: 18 Oct 2026. Har step ke saath yeh bhi likha hai ki kya check ho chuka hai aur kya NAHI (last section "Kya verify NAHI hua" zaroor padho).

> **Oracle Cloud ka VM hai to** Step A (Neon) aur Step B (Render) ki jagah [`docs/ORACLE_CLOUD_HINGLISH.md`](ORACLE_CLOUD_HINGLISH.md) follow karo (backend aur database usi VM par), phir Step C (Vercel) yahin se.

## 1. Big picture (2 line) aur ek zaroori sach

- Dashboard (website jo aap phone par kholte ho) Vercel par chalti hai. Trading bot + API ek alag, hamesha chalne wale server (backend) par chalte hain, jise Postgres database chahiye.
- Dashboard backend se baat karta hai ek secret ke saath; Delta ki API key kabhi Vercel par nahi jaati.

**Vercel akela bot 24x7 nahi chala sakta.** Vercel sirf dashboard (apps/web) host karta hai. Bot ko hamesha on rehne wala host chahiye (Render / Railway / Fly / VPS) aur ek managed Postgres (Neon / Supabase / Render Postgres). Demo mode ko Delta ki API key NAHI chahiye (sirf public market data), lekin backend phir bhi 24x7 chalna chahiye. Live mode ko API key (Trading permission, withdrawal nahi), IP whitelist (static outbound IP) chahiye aur woh tab tak band rehta hai jab tak aap khud dashboard me activate nahi karte.

Is guide me hum yeh banayenge:

| Hissa | Kahan | Kya hai |
|---|---|---|
| Database | Neon (free se shuru) | trades, settings, audit log yahan save hote hain |
| Backend (bot + API) | Render, Blueprint `render.yaml` se | hamesha chalne wala Docker service |
| Dashboard | Vercel, Root Directory `apps/web` | aapki website |

### Approx monthly kharcha (sirf andaaza, pricing badalti rehti hai: har site par current pricing check karo)

| Cheez | Approx | Note |
|---|---|---|
| Render web service, plan Starter | lagbhag US$7 / mahina | FREE plan mat lena: free service so jaati hai aur bot ruk jaata hai |
| Neon Postgres | US$0 se shuru; paid lagbhag US$5 - 20 / mahina | bot database ko har kuch second me use karta hai, isliye database kabhi "so" nahi pata. Free plan ke compute-hours poore mahine ke liye kam pad sakte hain: Neon ka current free limit check karo. Khatam hone par database ruk sakta hai aur bot bhi |
| Vercel Hobby | US$0 (personal use) | Pro plan US$20/mahina se, zaroorat nahi |
| Kul | lagbhag US$7 se US$30 / mahina | lagbhag Rs 600 se Rs 2,700 (USD-INR ~88 maan kar) |

Render ke paid plan ke liye card lagta hai (international payments on hone chahiye, check karo).

### Shuru karne se pehle: yeh sab ek jagah copy karna padega

Phone ka password manager use karo (Notes / screenshot / WhatsApp me secrets mat rakho). Retype mat karo, copy-paste karo.

| Kya | Kahan banta hai | Kahan paste hota hai |
|---|---|---|
| Neon connection string (`postgresql://...`) | Step A | Render `DATABASE_URL` |
| `ADMIN_PASSWORD` (aap khud banate ho, kam se kam 12 characters) | Step B | Render `ADMIN_PASSWORD`; dashboard login me bhi yahi |
| Backend URL (`https://....onrender.com`) | Step B ke baad | Vercel `BACKEND_URL` |
| `PROXY_SHARED_SECRET` (Render khud banata hai) | Step B ke baad Render ke Environment tab me | Vercel `PROXY_SHARED_SECRET` (bilkul same) |

Dhyan do: `render.yaml` aur `Dockerfile` GitHub repo ki `main` branch par hain: Render/Vercel dono me branch `main` hi chuno (kaam wali branch `ccr-12ad71d8-4mu4gv` ke saath `main` same commit par hai).

## 2. Step A: Postgres (Neon free)

1. Browser me neon.com (ya neon.tech) kholo. "Sign up" par tap karo, GitHub ya Google se login karo.
2. "Create project" (ya "New project") par tap karo.
   - Name: `cryptoalgo`
   - Postgres version: jo default ho woh theek hai
   - Region: AWS Asia Pacific (Singapore). Render bhi Singapore me hoga, isliye database paas rahega.
3. Project ban jaye to dashboard par "Connect" (ya "Connection details") par tap karo.
4. **Connection pooling ka toggle OFF karo** (direct connection). Host ke naam me `-pooler` nahi hona chahiye. Ek hamesha chalne wala server database se kuch hi connections rakhta hai, isliye direct sabse seedha hai. (Pooled string bhi chalni chahiye kyunki app koi session-level feature use nahi karta, lekin humne dono Neon par test nahi kiye. Agar kabhi "too many connections" aaye to pooled string try karo.)
5. Connection string ko poora copy karo. Aisi dikhti hai:
   `postgresql://neondb_owner:PASSWORD@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`
   - `?sslmode=require` waise hi rehne do. Isse connection encrypted rehta hai. Is wajah se `DATABASE_SSL` set karne ki zaroorat nahi.
   - Kuch edit mat karo. Sirf URL copy karo: `psql` shabd, quotes ya space nahi. (Galti se quotes ya space aa jayein to server unhe hata deta hai. Poora `psql '...'` command paste hua to server start hi nahi hota aur saaf error line deta hai.)
6. Is string ko apne password manager me rakh lo (Notes ya screenshot me nahi). Isme database ka password hai: kisi ko mat bhejo.

Supabase ya Render Postgres bhi chalenge (koi bhi `postgresql://` string), par humne sirf Neon ke liye likha hai. Supabase ke certificate ke liye shayad `DATABASE_SSL=no-verify` chahiye. Yeh bhi test nahi hua.

## 3. Step B: Backend Render par (Blueprint se)

1. render.com kholo, "Get Started" / sign in, GitHub se login karo.
2. Dashboard me "New +" par tap karo, phir "Blueprint" chuno.
3. GitHub connect karo aur apni repo (Crypto-Algo) ko access do. Repo chuno, branch confirm karo.
4. Render `render.yaml` padhega aur ek service dikhayega: `cryptoalgo-server` (Docker, region Singapore, plan Starter, health check `/api/health`).
5. Render do cheezein poochega (baaki sab apne aap ban jaati hai):
   - `DATABASE_URL`: Step A wali Neon string paste karo.
   - `ADMIN_PASSWORD`: dashboard ka login password. **Kam se kam 12 characters.** Phone ke password manager se "strong password" banao aur copy karke yahan paste karo. Shuru ya aakhir me space mat rakho. Is password ko save kar lo, yahi login me chalega. (Server isse start hote hi bcrypt se hash kar leta hai. Logs me ek warning aayegi ki `ADMIN_PASSWORD_HASH` behtar hai: abhi ignore karo.)
6. "Apply" / "Deploy Blueprint" par tap karo.
7. Build me 3 se 8 minute lag sakte hain. Service ke page par status "Live" hone tak ruko. Dikhne wala URL (page ke upar) copy karo, jaise `https://cryptoalgo-server-xxxx.onrender.com`. Yeh aapka **backend URL** hai.
8. Jaanch: browser me `BACKEND-URL/api/health` kholo. Aisa kuch dikhna chahiye:
   `{"ok":true,"db":true,"workerActive":true,"time":...}`
   `ok:true` ka matlab database se connection hai.

### Render ne kya khud banaya aur kya aapne diya

| Variable | Kaun deta hai | Kaam |
|---|---|---|
| `DATABASE_URL` | aap (Neon string) | database |
| `ADMIN_PASSWORD` | aap | dashboard login (username `admin`) |
| `SESSION_SECRET` | Render khud banata hai | login session sign karta hai |
| `CREDENTIAL_ENCRYPTION_KEY` | Render khud banata hai | baad me dashboard me save ki gayi Delta API key ko encrypt karta hai. Is value ko kabhi mat badlo, warna saved key padhi nahi jayegi |
| `PROXY_SHARED_SECRET` | Render khud banata hai | sirf aapka Vercel dashboard backend ko call kar sakta hai. **Isko Vercel me bhi daalna hai** |
| `NODE_ENV`, `DELTA_ENV=production`, `MARKET_DATA_SOURCE=delta`, `BOT_AUTOSTART=true`, `LIVE_HARD_DISABLE=false` | `render.yaml` | demo ke liye theek hain, Live phir bhi band rehta hai |

### PROXY_SHARED_SECRET kahan se padhna hai

1. Render me service `cryptoalgo-server` kholo.
2. "Environment" tab par jao.
3. `PROXY_SHARED_SECRET` ki value dikhane ke liye "reveal" / aankh wale icon par tap karo (agar chhupi hai), phir poori value copy karo (aage-peeche space nahi). Yeh Step C me Vercel me jayegi.

### Agar Blueprint error de

`render.yaml` Render ke liye yaadasht se likhi gayi hai aur yahan chalayi nahi gayi (sirf YAML syntax check hua). Agar Render kisi field par error de:

1. "New +" par tap karo, "Web Service" chuno, apni repo chuno.
2. Language: **Docker**. Region: **Singapore**. Instance type: **Starter** (Free nahi). Health Check Path: `/api/health`. Instances: 1.
3. Environment me yeh daalo: `NODE_ENV=production`, `DATABASE_URL` (Neon), `ADMIN_PASSWORD` (12+ characters), `DELTA_ENV=production`, `MARKET_DATA_SOURCE=delta`, aur teen random secrets: `SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `PROXY_SHARED_SECRET`. Teeno ke liye password manager se 40 characters ka random string banao (sirf letters aur numbers sabse safe). Server `CREDENTIAL_ENCRYPTION_KEY` ke liye 32+ characters ka koi bhi random secret maan leta hai.

### Optional: Auto-Deploy band karna

Render service me Settings, "Build & Deploy", "Auto-Deploy" ko Off kar sakte ho. Warna GitHub par har naye commit par backend redeploy hoga (bot restart hota hai; woh safely wapas sync ho jaata hai, par live trading ke dauran isse bachna behtar hai).

### Railway (agar Render nahi chalta)

Repo me `railway.json` hai (Dockerfile builder, health check `/api/health`, 1 replica). Railway par: New Project, Deploy from GitHub repo, repo chuno. Variables me Render wali hi list daalo, Settings, Networking me "Generate Domain". Yeh `railway.json` ki schema yaadasht se hai, chalayi nahi gayi. Railway ka kharcha usage-based hai (Hobby plan lagbhag US$5 se, current pricing check karo). Static outbound IP (Live ke liye) Railway par alag feature hai: check karo.

## 4. Step C: Dashboard Vercel par

1. vercel.com kholo, GitHub se login karo (Hobby plan).
2. "Add New..." par tap karo, "Project" chuno. "Import Git Repository" me apni repo (Crypto-Algo) ke saamne "Import" dabao. GitHub access maange to do.
3. "Configure Project" screen par:
   - **Framework Preset:** Next.js (apne aap aa jaana chahiye).
   - **Production Branch:** `main` (Project banne ke baad: Settings, Git, Production Branch. GitHub par bhi Settings, Branches, Default branch ko `main` kar do, taaki Vercel/Render apne aap `main` uthayen).
   - **Agar "Services" / "Multiple applications detected" wali screen aaye** (Root Directory `./`, Application Preset "Services"): ye Vercel ki auto-detection hai, kyunki repo ke root par Dockerfile aur `railway.json` (backend ke liye) hain. Ye ghalat raasta hai. **`apps/web` wali Next.js row ("web-2" / "Next.js") ke saamne "Import single project" dabao**, ya neeche wala Root Directory `apps/web` karo. Wahan "Copy prompt" me jo `vercel.json` suggest hota hai use repo me **mat daalo**. Root Directory `apps/web` hone par Preset apne aap Next.js ho jaata hai.
   - **Root Directory:** "Edit" par tap karo aur `apps/web` chuno. Continue. (Yeh sabse zaroori step hai. Ye na ho to build fail hoga.)
   - Build and Output Settings ko haath mat lagao: `apps/web/vercel.json` install aur build command khud set karta hai (`cd ../.. && npm ci --include=dev` aur `npm run build`).
   - **Node.js Version:** jo default ho woh theek hai (22.x ya naya; Next.js 16 ko 20.9 ya upar chahiye). Agar chunna pade to 22.x.
   - **Environment Variables** (neeche wali do, dono):

     | Name | Value |
     |---|---|
     | `BACKEND_URL` | Step B ka backend URL: `https://....onrender.com` (https se shuru, **end me `/` nahi**, `/api` nahi) |
     | `PROXY_SHARED_SECRET` | Render ke Environment tab se copy ki hui value, bilkul same |

   - Aur kuch mat daalo. Khaas taur par: koi bhi `NEXT_PUBLIC_...` variable nahi, Delta API key nahi, aur `NODE_ENV` bilkul nahi.
4. "Deploy" par tap karo. 1 se 3 minute me build khatam hoga.
5. Project Settings, General me "Root Directory" ke paas "Include source files outside of the Root Directory in the Build Step" ka option **ON** rehna chahiye (naye project me default ON hota hai). `apps/web` ko repo ke baaki folders (jaise `packages/core`) chahiye.
6. Deploy hone par aapko URL milega, jaise `https://crypto-algo.vercel.app`. Isse bookmark karo. Hamesha yahi main URL use karo (har deployment ka alag lamba URL nahi: us par Vercel login maang sakta hai).

Baad me koi environment variable badlo to Vercel me Deployments, tin dots (...), "Redeploy" karna padega: tabhi nayi value lagti hai.

Quick jaanch: `https://VERCEL-URL/api/health` kholo. Wahi JSON aana chahiye jo Render par aaya tha (`ok:true`). `{"error":"backend_unreachable",...}` aaye to `BACKEND_URL` galat hai ya backend band hai. Dhyan do: health check secret nahi maangta, isliye yeh `PROXY_SHARED_SECRET` ki jaanch nahi karta: uski jaanch login se hoti hai.

## 5. Step D: Site kholo aur login karo

1. Vercel URL kholo. Login screen aayegi. Username `admin`, password woh jo Render me `ADMIN_PASSWORD` me daala.
2. Sahi Demo screen aisi dikhti hai:
   - Upar ek status line: **"DEMO MODE — LIVE TRADING DISABLED"**.
   - "Bot running · worker active".
   - Status bar me **Market data: WebSocket live** aur uske saamne **hara dot**. Agar "REST fallback" (peela) hai to bhi chal raha hai; "DOWN" (laal) hai to Troubleshooting dekho.
   - "Exchange account API: not configured" (demo me yehi normal hai, key chahiye hi nahi).
   - "Scalper Offer: assumed · no closing fee ≤ 30 min" (peela dot normal hai; neeche section 6 dekho).
   - ETHUSD ka price upar dikhta hai. Demo account virtual balance se shuru hota hai (default US$100).
3. **Trades turant nahi aayenge.** Strategy tabhi trade leti hai jab setup mile aur fees ke baad bhi faayda bane. Ghante lag sakte hain, shaant market me poora din bhi zero trades aa sakte hain. Yeh normal hai, kharabi nahi. Demo tab me "last decision" / risk checks se dikhta hai ki bot ruka kyun hai.

Pehle 1 se 2 hafte sirf Demo chalne do (docs/GO_LIVE_CHECKLIST.md ka hissa A).

## 6. Delta ka Scalper Offer (fee kam karne wala offer)

Yeh terms operator ne diye hain, aur inhe Delta ke asli exchange se verify NAHI kiya gaya (sandbox se Delta tak pahunch nahi hai).

- **Close within 30 minutes** (BTCUSD aur ETHUSD ke liye; baaki futures ke liye 15 minutes): eligible trade par **closing fee nahi lagti**. **Opening fee phir bhi lagti hai.** Delta ka example: opening maker fee 0.02% ($12 on $60,000) lagti hai, closing taker fee 0.05% ($30.05) maaf.
- Aapke Delta account ne offer **join** kiya hona chahiye. Join karne se pehle ke trades eligible nahi. Ek baar activate karne ke baad deactivate nahi hota. Join kahan karna hai woh Delta ki app/website par dekho (hume Delta ka UI verify nahi).
- Liquidation eligible nahi. Partially closed position eligible hai. Internal / corporate / RMM / MM / KOL fixed-fee users ke liye nahi hai.
- Delta offer ko bina bataye badal ya band kar sakta hai.
- **Diwali Scalper Offer** (opening fee Fee Voucher ke roop me wapas; sirf BTCUSD; 25 Sep 2026 se; $100 per user per month cap) alag offer hai. Yeh bot ETHUSD par chalta hai, isliye woh **lagu nahi hota aur bot me model bhi nahi hai**.

Bot kya karta hai:

- Offer API se padha nahi ja sakta, isliye Demo, backtest aur trade se pehle ke fee hisaab me offer **maan liya** jaata hai. Setting: Strategy & Risk tab, card "Delta Scalper Offer (closing-fee waiver)", toggle "Assume the Scalper Offer" (default ON; OFF karoge to har jagah poori closing fee ginti hai).
- Isliye time exit **28.5 minute** par lagta hai (30 minute minus 90 second ka safety margin), taaki trade window ke andar band ho.
- Demo me trade 30 minute ke andar band ho to sirf entry fee lagti hai (simulated).
- **Live** me P&L hamesha wahi commission lagta hai jo exchange ne asli me charge ki (woh authoritative hai).
- Live me jo trades 30 minute ke andar band hote hain, bot unki closing fee check karta hai (pehle eligible close se shuru). Agar Delta ne closing fee nahi li to status "confirmed" ho jaata hai. Agar Delta ne closing fee li, to status "NOT APPLIED" ho jaata hai: bot phir poori fee ke hisaab se hisaab lagata hai, time exit ko clamp nahi karta, aur is wajah se kam trade leta hai (zyada nahi).
- Bina offer ke ek taker round trip lagbhag $0.71 ka padta hai (default size 0.20 ETH, ETH $3,000 par), offer ke saath lagbhag aadha (sirf entry fee $0.354). Isliye offer join kiye bina Live mat jao.

## 7. Live: abhi ON MAT KARO

Live trading default me band hai aur band hi rehni chahiye. Pehle yeh sab:

1. Demo kam se kam 1 se 2 hafte, trades aur drawdown samajh ke.
2. **Testnet pehle.** Delta India ka demo (testnet) account aur uski alag API key. Render me `DELTA_ENV=testnet` karke rehearsal karo. Testnet key production par nahi chalti aur ulta bhi.
3. **Static IP.** Delta trading wali API key par IP whitelist maangta hai. Render ke outbound IPs region ke sab Render services ke saath share hote hain (Render dashboard, service, Connect, Outbound). Live ke liye dedicated static IP wala host (Fly egress IP ya VPS) behtar hai. Delta ki whitelisting aur yeh ki Render ke IP badalte hain ya nahi: yeh yahan verify nahi hua, Render ke docs me check karo.
4. **API key permissions:** Trading **YES**, Withdraw / transfer ka koi bhi option **NO**. Key sirf backend me jaati hai (dashboard ke Settings me "Exchange connection" se, jo `CREDENTIAL_ENCRYPTION_KEY` se encrypt karke database me rakhti hai). Vercel me kabhi nahi.
5. **Hard lock:** Agar dar hai ki galti se Live arm ho jaye, to Render me Environment me `LIVE_HARD_DISABLE` ko `true` kar do aur redeploy. Tab dashboard se Live arm karna impossible hai. Jab poori taiyari ho tab hi `false` karo.
6. Poora checklist: **docs/GO_LIVE_CHECKLIST.md**. Roz ka runbook: docs/OPERATIONS.md. Fee ka hisaab: docs/STRATEGY_AND_FEES.md.

## 8. Troubleshooting

| Problem | Sabse likely wajah | Kya karo |
|---|---|---|
| Login: "Invalid username or password" jabki password sahi hai | Render ka `PROXY_SHARED_SECRET` aur Vercel ka alag hai. Backend 403 deta hai aur login form isi message ke saath dikhata hai. (Ya password ghalat type hua) | Dono value dobara copy-paste karo, Vercel me Redeploy. Password: Render me `ADMIN_PASSWORD` dekho |
| "Too many failed attempts. Try again in 15 minutes." | 5 galat try par lock | 15 minute ruko, ya Render par service restart / redeploy karo (lock memory me hai, restart par saaf ho jaata hai) |
| "The trading backend is not reachable." / dashboard: "unreachable" / Vercel se 502 | `BACKEND_URL` galat ya missing (trailing `/`, `http`, `/api` laga hai), ya backend crash / deploy ho raha / sleep (Free plan) | Render URL + `/api/health` browser me kholo. Na khule to Render Logs dekho. Khule to Vercel me `BACKEND_URL` theek karo aur Redeploy |
| Vercel build fail | Root Directory `apps/web` nahi; "Include source files outside..." OFF; Vercel me `NODE_ENV` set kiya | Settings, General me Root Directory theek karo; `NODE_ENV` variable hatao; Redeploy |
| Render deploy fail / service baar baar restart | Environment ki koi value galat. Logs me ek line hogi "Configuration error: ..." jo setting ka naam batati hai. Database ke liye "Hint: ..." line aati hai | Logs me woh line padho, Environment me wahi variable theek karo, save |
| Vercel URL par "Authentication Required" / Vercel login maang raha hai | Aap deployment ka lamba URL khol rahe ho (Vercel ki Deployment Protection) | Project ka main URL (`project-naam.vercel.app`) kholo; phir bhi aaye to Vercel, Settings, Deployment Protection dekho |
| Dashboard khulta hai par "Market data: DOWN" | Render se Delta tak pahunch nahi ya Delta ka outage | Kuch minute ruko (apne aap reconnect hota hai). Render Logs me `market data error` lines dekho. Is dauran bot naye trade nahi leta (fail-closed) |
| Bot idle, trades nahi | Normal ho sakta hai: market shaant, ya fees ke baad faayda nahi. Ya bot Stopped / Kill switch ON | Demo tab: "Bot running" aur kill switch dekho, "last decision" / risk checks padho. Hafte bhar me bhi trades na ayen tab Strategy & Risk dekho |
| Password bhool gaye | - | Render, Environment, `ADMIN_PASSWORD` badlo, Save (redeploy hoga). Agar `ADMIN_PASSWORD_HASH` bhi set hai to woh jeetta hai: use hata do |
| Neon DB band / "database" error | Free compute limit khatam ya project pause | Neon dashboard me usage dekho, paid plan par jao ya naya database; `DATABASE_URL` update |

### Logs kaise padhein

- **Render (backend):** service, "Logs" tab. Har line JSON hoti hai: `"level":"warn"` ya `"error"` dhundo. Start hone par ek line aati hai `DEMO MODE — LIVE TRADING DISABLED` (port, db, marketData ke saath). Logs me secret values nahi chhapti (humne boot logs me jaanch ki).
- **Vercel (dashboard):** project, "Logs" (Runtime Logs), ya Deployments me deployment kholo, "Build Logs" / "Runtime Logs".

## 9. Kya verify NAHI hua (seedhi baat)

Yeh guide aur files likhne wale ne kuch bhi asli Render, Vercel, Neon, Railway, Fly ya Delta par deploy ya run nahi kiya.

Jo sandbox me asli me chala aur dekha gaya:
- Saaf clone (git ke tracked + untracked files) me `npm ci`, phir `apps/web` me `npm run build` (VERCEL=1 ke saath, `BACKEND_URL` / `PROXY_SHARED_SECRET` ke bina bhi) pass hua. Dev-dependencies ke bina (`NODE_ENV=production` install) build fail hota hai, isliye `vercel.json` ka install command `--include=dev` use karta hai.
- Backend ka production-mode boot (embedded PGlite, Delta unreachable): process zinda raha, `/api/health` ne `ok:true` diya, market data "down" dikha (crash nahi), proxy secret ke bina login 403, sahi secret + `ADMIN_PASSWORD` se login 200, Live disabled (preflight fail, `liveArmed:false`), logs me secret nahi mila, PID se band kiya.
- Galat config par saaf "Configuration error: ..." line aur exit code 1; galat database host par "Hint: ..." line.
- Config tests (`apps/server/test/config.test.ts`) pass aur `tsc` clean hai. Docker Dockerfile ke steps haath se (Node 22) dohraye gaye: build, runtime manifest, `npm install --omit=dev`, boot.

Jo verify NAHI hua:
- Render Blueprint (`render.yaml`) kabhi run nahi hua; sirf YAML syntax check hua aur field naam yaadasht se hain. `railway.json` bhi yaadasht se hai.
- Sandbox me Docker daemon nahi tha, par GitHub CI ke `docker` job ne image sach me build ki (amd64) aur container ka health check pass hua (run on `main`). ARM par aur asli host par nahi chali. `docker-compose.yml` sirf `docker compose config` se parse hua.
- Asli Postgres (Neon) se connection, pooled vs direct, SSL: kuch test nahi hua. Sirf embedded database aur "host nahi mila" wala failure path chala.
- Vercel par asli build nahi hua; Root Directory, "Include source files outside of the Root Directory" aur Node version ki jaankari Vercel docs se aur local simulation se hai. Browser se Vercel se backend tak poora chain ek saath nahi chala (sirf backend curl se proxy header ke saath, aur dashboard alag).
- Delta ke hosts sandbox se unreachable hain. Scalper Offer ke terms, IP whitelisting, API key permissions, Delta ke UI ke shabd: sab operator-diye ya maane hue hain, Delta se verify nahi.
- Kharche ke numbers, Neon free limits, Render/Vercel/Neon ke screen ke shabd yaadasht se hain aur badal chuke ho sakte hain.
- Live trading kisi bhi tarah test nahi hui. Pehle testnet.

Kuch bhi ajeeb lage to rukiye aur Live kabhi mat chalaiye jab tak docs/GO_LIVE_CHECKLIST.md poora na ho.
