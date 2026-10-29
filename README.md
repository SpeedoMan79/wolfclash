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

## v2 Upgrade
- **eSports UI** (user app): angular HUD look, Chakra Petch font, raised Home button, prize-pool badges, LIVE tags.
- **Slot system**: Solo = 1 user / 1 slot • Duo = Team N → A,B • Squad = A,B,C,D. User join karte waqt slot choose karta hai, **Change slot** bhi kar sakta hai. Admin: Slots = players (Solo) ya teams (Duo/Squad).
- **Image upload** (admin): logo, banners, games, match banner, notification image. Image browser me compress hoti hai aur Redis me save hoti hai (`/img/<id>`), isliye Render restart par bhi safe. Max ~650KB per image.
- **Admin → Match View**: room ID/pass update (+ players ko notification), message to all / single player, slot map with IGN + app username, Move / Kick(+refund).
- **Admin → Result**: rank + kills enter karo → rank prize (match me set Rank prizes) + per-kill auto, total preview, winners ko notification. Duo/Squad me team ka rank sync hota hai, optional prize split.
