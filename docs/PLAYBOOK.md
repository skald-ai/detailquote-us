# DetailQuote-US — Плейбук запуска, поиска клиентов в США и приёма USD

Подробное руководство по эксплуатации **DetailQuote-US**: как работает связка Cloudflare Pages + D1, как за 10 секунд клонировать демо под нового детейлера в США и как принимать долларовые оплаты без риска блокировок личных карт.

---

## 1. Почему эта модель сильнее кейса из видео
- **Бесплатный/копеечный Edge вместо десятков VPS:** все магазины работают на одном домене `https://detailquote-us.pages.dev` (Cloudflare Pages Functions + D1 SQLite) по маршрутам `/s/<slug>`, а не на отдельных VPS с «левыми почтами». Для локальной отладки остаётся идентичный `app.py` (FastAPI + SQLite).
- **Долларовый чек вместо 4 900 ₽:** в США один спасённый выездной заказ приносит детейлеру `$180–$750`, поэтому настройка за **`$299–$499` + `$49/мес`** окупается с первого клиента.
- **Нет телефонной игры и потери фото:** клиент выбирает кузов, пакет, состояние, крепит до 4 фото дефектов (сжатие на клиенте до `1024px` JPEG), получает ориентировочную вилку и живую ссылку заказа.
- **Момент удержания без тяжёлого 3D:** на странице статуса клиент стирает пальцем слой пыли (`<canvas>`) и активирует бонусный кредит (`-$25`) к записи; у владельца — кабинет с фото, подтверждением точной цены и 1-кликовой отправкой SMS со ссылкой.

---

## 2. Живые демо и локальный запуск

### Прод на Cloudflare Pages + D1
- **Витрина всех демо (Agency Hub):** `https://detailquote-us.pages.dev/demos`
- **Демо клиента (Austin, TX):** `https://detailquote-us.pages.dev/s/apex-austin`
- **Демо клиента (Miami, FL):** `https://detailquote-us.pages.dev/s/harbor-miami`
- **Кабинет владельца (демо PIN `2026`):** `https://detailquote-us.pages.dev/s/apex-austin/owner`

### Локальный запуск на компьютере (FastAPI + SQLite)
Зависимости: `fastapi`, `uvicorn`, `httpx`, `beautifulsoup4` (Python 3.11+).

```powershell
cd D:\AI-Agents-Lab\projects\DetailQuote-US
.\start.cmd
```

Откройте `http://127.0.0.1:8787/demos`. При первом старте создаются 2 реалистичных демо-лида для `apex-austin` (`DQ-7482AT` и `DQ-6194SY`), чтобы кабинет сразу не выглядел пустым на созвоне.

---

## 3. Деплой обновлений на Cloudflare Pages

```powershell
python -X utf8 deploy_cf.py
```

Скрипт `deploy_cf.py` сам:
1. Создаёт/проверяет D1 базу `detailquote-us-db` и проект Pages `detailquote-us`.
2. Привязывает binding `DB` и секреты `DETAILQUOTE_SECRET` / `DETAILQUOTE_ADMIN_KEY` (хранятся только в локальном `.env`, в Git не попадают).
3. Собирает `dist-cf/` через `build_cf_pages.py` и деплоит в production-ветку `main`.

---

## 4. Как клонировать демо под реального клиента и сразу публиковать в прод

```powershell
python -X utf8 tools/new_tenant.py `
  --name "Lone Star Mobile Detail" `
  --city "Dallas" `
  --state "TX" `
  --phone "+1 (214) 555-0177" `
  --instagram "@lonestardetail" `
  --accent "#e59934" `
  --full 275 `
  --ceramic 650 `
  --push-live
```

С флагом `--push-live` скрипт:
1. Создаст локальный файл `tenants/lone-star-mobile-detail-dallas.json`.
2. Мгновенно зальёт его в живую базу Cloudflare D1 через `/api/admin/tenants` (без пересборки и повторного деплоя!).
3. Выдаст рабочую HTTPS-ссылку `https://detailquote-us.pages.dev/s/lone-star-mobile-detail-dallas`, PIN кабинета владельца и 3 готовых письма на английском (Instagram DM, SMS, Cold Email).

---

## 5. Поиск «горячих» клиентов в США и автоматический аудит

Скрипт `tools/prospect_audit.py` проверяет сайты детейлеров, ищет отсутствие онлайн-калькулятора (`No instant quote / Call for quote / Free estimate`), вытаскивает телефоны, email, Instagram и считает `opportunity_score` (`0–100`):

```powershell
python -X utf8 tools/prospect_audit.py `
  --input prospects.csv `
  --build-demos `
  --push-live
```

Или по списку URL:
```powershell
python -X utf8 tools/prospect_audit.py `
  --urls https://detailer1.com https://detailer2.com `
  --build-demos `
  --push-live
```

В папке `outreach/` появятся `audit_report.csv` и `outreach_pack.md` с готовыми персональными письмами, ссылающимися на найденные «дыры» на сайте клиента и его персональное живое демо.

### Уведомления владельцу в Telegram / Webhook
В конфиге тенанта (`tenants/<slug>.json`, а затем `--push-live`) или в секретах Cloudflare (`DETAILQUOTE_TG_BOT_TOKEN`, `DETAILQUOTE_TG_CHAT_ID`, `DETAILQUOTE_WEBHOOK_URL`) можно указать Telegram-бота или URL вебхука (n8n / Make / Twilio): каждая новая заявка сразу прилетит владельцу.

---

## 6. Ежедневный 60-минутный конвейер и приём USD (без 115-ФЗ)

### Рутина на каждый день (цель: 20–30 касаний/день)
1. **15 мин:** Соберите 20–30 мобильных детейлеров в одном среднем городе США (Austin, Dallas, Phoenix, Tampa, Charlotte, Denver).
2. **10 мин:** Прогоните их через `prospect_audit.py --build-demos --push-live` и выберите тех, у кого нет онлайн-калькулятора, но живой Instagram/отзывы.
3. **35 мин:** Отправьте персональные Instagram DM / Cold Email с готовой HTTPS-ссылкой на **их собственное демо**.

### Легальный приём долларов (актуально на ноябрь 2026)
Не принимайте серийные переводы на личную карту физлица. Рабочие рельсы зависят от вашего резидентства (подробный комплект текстов и условий — в локальном `outreach/PAYMENT_AND_OFFER_KIT.md`):

**Для резидентства РФ (заказчик из США платит картой/переводом в USD → выплата вам):**
1. **[EasyStaff Invoice](https://easystaff.io):** выставление B2B-инвойса на `$299–$399`, заказчик из США оплачивает картой/банком, платформа берёт ~6%+ и даёт закрывающие документы.
2. **[Lava.top](https://lava.top):** приём зарубежных карт (включая США) и поддержка ежемесячной подписки (`$49/мес`).
3. **[Solar Staff](https://solar-staff.com) / [Mellow](https://mellow.io):** официальные B2B-контракты и выплаты с документами.

**Для зарубежного счёта / паспорта вне РФ / US LLC:**
1. **Upwork Direct Contracts:** клиент из США платит картой, PayPal или US ACH по гостевой ссылке без регистрации на Upwork (5% комиссии, либо 0% с Freelancer Plus).
2. **[Whop](https://whop.com):** страница оплаты с комиссией 2.7% + $0.30, подходит для связки `$399 + $49/мес` (ограничивает выплаты в РФ/РБ).
3. **US LLC + Mercury/Wise + Stripe:** целевой вариант при 5+ регулярных клиентах.
4. **USDC / USDT (Base / Arbitrum / Tron):** резервный вариант по запросу, если клиент готов платить в крипте.

> *Примечание:* **Lemon Squeezy** в новых воронках не используем — сервис объявил о прекращении обработки транзакций **31 марта 2027 года** после поглощения Stripe и не выплачивает в РФ.
