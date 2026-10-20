# Установка на VPS (для себя)

## Что нужно
- VPS: 2 vCPU, 2–4 ГБ RAM, x86_64, Ubuntu 22.04/24.04 или Debian 12. На 1 ГБ — добавь `LOW_MEMORY_MODE=true` и `CHILD_PROC_MAX=2` в `.env`.
- Домен (или бесплатный поддомен DuckDNS). A-запись → IP сервера.
- Открытые порты 80 и 443.

## Установка
```bash
# Docker
curl -fsSL https://get.docker.com | sh

# Код (скопируй архив форка на сервер и распакуй, либо git clone своего форка)
cd live-sport-plugin
cp .env.example .env
nano .env            # DOMAIN=sport.твойдомен.ru, ACME_EMAIL=почта

docker compose up -d --build
docker compose logs -f nuvio     # первый синк матчей ~1–2 мин
```
Проверка: открой `https://ДОМЕН/health` — должен быть `"status":"ok"`.

## Подключение
- **Stremio:** `https://ДОМЕН/configure` → выбери виды спорта → Install.
- **Nuvio:** Settings → Addons → вставь `https://ДОМЕН/manifest.json`.
  Коллекции реплеев: импорт по ссылке `https://ДОМЕН/collections.json`.

## Обновление
```bash
docker compose up -d --build     # кэш матчей в ./data сохраняется
```

## Тонкая настройка (`.env`)
- Список стримов появляется слишком рано и мало вариантов → увеличь `STREAM_FIRST_RESULT_GRACE_MS` (например 3000).
- Нужна сортировка по реальной скорости CDN → `ENABLE_SPEED_PROBE=true` (клик станет медленнее на 1–5 с).
- Сервер слабый → `CHILD_PROC_MAX=2`.
- DamiTV режется по IP дата-центра → поставь Cloudflare WARP на хост в режиме proxy и укажи
  `WARP_PROXY_URL=socks5://host.docker.internal:40000` (плюс `extra_hosts: ["host.docker.internal:host-gateway"]` у сервиса `nuvio`).

## Диагностика
- `https://ДОМЕН/health` — память, открытые circuit breaker'ы, кэш стримов, дочерние процессы.
- `https://ДОМЕН/api/provider-health` — состояние каждого провайдера после синка.
