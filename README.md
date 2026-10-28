# Arena Battle – Deploy

1. GitHub: 4 files (index.html, admin.html, server.js, package.json) repo me push karo.
2. Upstash: Redis database banao -> REST URL + REST TOKEN copy karo.
3. Render: New Web Service -> repo select. Build: `npm install`, Start: `npm start`.
4. Render Environment Variables:
   - UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
   - JWT_SECRET (lamba random string)
   - ADMIN_USER, ADMIN_PASS
   - ZAPUPI_TOKEN, ZAPUPI_SECRET
   - BASE_URL = https://your-app.onrender.com
5. Zapupi dashboard me webhook URL: https://your-app.onrender.com/api/zapupi/webhook
6. Admin panel: /admin
