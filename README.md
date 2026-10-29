# Arena Battle — Deploy guide

Files: `index.html` (user app) • `admin.html` (admin panel at `/admin`) • `server.js` • `package.json`

## 1. GitHub
Ye 5 files (+ `.gitignore`) ek repo me push karo.

## 2. Upstash
Redis database banao → **REST URL** aur **REST TOKEN** copy karo.
(Bina Upstash env ke server in-memory chalta hai — restart par data ud jata hai, sirf testing ke liye.)

## 3. Render
New → Web Service → repo select. Build: `npm install` • Start: `npm start`

Environment variables:
| Key | Value |
|---|---|
| UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN | Upstash se |
| JWT_SECRET | lamba random string |
| ADMIN_USER / ADMIN_PASS | admin login (strong password!) |
| ZAPUPI_TOKEN / ZAPUPI_SECRET | Zapupi dashboard se |
| BASE_URL | https://your-app.onrender.com |
| ZAPUPI_API | (optional) Zapupi API base URL |

## 4. Zapupi
Webhook URL: `https://your-app.onrender.com/api/zapupi/webhook`
⚠️ `server.js` me `/create-order` aur `/order-status` ke field names (token_key, secret_key, order_id…) Zapupi ke latest docs se match karke verify karo.

## 5. Admin
`https://your-app.onrender.com/admin` — Settings me app name, logo, banners, bonuses, maintenance sab badal sakte ho.

## Features
**User app:** login/signup • home with banners, announcement, quick actions • daily reward • promo codes • referral • games & matches (countdown, room ID after join) • wallet (deposit / win / bonus) • Zapupi add cash with bonus preview • withdraw (fee + daily limit) • leaderboard (weekly/monthly/all) • top players • statistics • profile (avatar, in-game name, change password) • notifications • support tickets • rules / FAQ / about / terms.

**Admin:** dashboard with 7-day chart & KPIs • maintenance toggle • bonus to all users • matches (create / edit / duplicate / room / start / result / cancel+refund) • games • users (search, details, balance ±, ban, reset password, CSV) • withdrawals (approve / reject, fee, CSV) • deposits (re-check gateway, manual approve) • promo codes • support tickets chat • notifications • full settings (bonus tiers & banners editor) • activity log.

## Note
Free Render service 15 min inactivity ke baad sleep hota hai (pehla load slow). Data Upstash me safe rehta hai.
