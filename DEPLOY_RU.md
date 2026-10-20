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

## Прокси для всего исходящего трафика (xray)
Все запросы аддона (источники, плейлисты, сегменты, расшифровка, логотипы) можно пустить через один прокси.
Локальные адреса, внутренний резолвер и Caddy идут напрямую.

**Важно:** токены в ссылках привязаны к IP. Если у xray балансировщик (`leastPing` и т.п.), выход может смениться между
запросом плейлиста и сегментов, и CDN ответит 403. Поэтому для аддона нужен **отдельный вход xray с фиксированным выходом**:

```bash
# 1) добавить вход nuvio-in (порт 1081) -> выбранный выход; остальные входы и правила не трогаются
python3 deploy/xray-add-inbound.py /opt/smm-ve/deploy/xray/config.json proxy-finland
docker exec smm-ve-xray-1 xray run -test -config /etc/xray/config.json   # проверка конфига
docker restart smm-ve-xray-1                                              # секунда простоя xray

# 2) .env аддона
echo 'OUTBOUND_PROXY_URL=socks5://smm-ve-xray-1:1081' >> .env
echo 'XRAY_NETWORK=smm-ve_internal' >> .env

# 3) запуск с подключением к сети xray
docker compose -f docker-compose.yml -f docker-compose.xray.yml up -d --build
docker compose logs nuvio | grep outboundProxy    # должно быть: outbound traffic -> socks5://...
```
Сменить страну выхода: поправить `outboundTag` в правиле для `nuvio-in` и перезапустить xray.
Вернуть как было: убрать `OUTBOUND_PROXY_URL` из `.env` и запускать без `docker-compose.xray.yml`.
