# План размещения на одном сервере

Сервер ещё не арендован. Образ и production-compose уже в репозитории: `Dockerfile`, `docker-compose.prod.yml`.
Флаги этим планом не меняются. Схема приезжает миграциями, включая `20261015140000_deposit_window_expiry`.
Живой обмен с сервера не включается, пока отдельно не поставлен `CHANGENOW_ENABLED=true`.

## Что уже запущено локально

`docker-compose.yml` поднимает только PostgreSQL 18. Порт опубликован на `127.0.0.1`, данные лежат в томе `postgres_data` проекта `changenow-exchange`.
Этот том остаётся на ноутбуке. На сервер его не копировать: там тестовые и уже закрытые заявки.

Приложение — один процесс Node.js (`src/index.ts`): HTTP с `GET /health`, Telegram-бот long polling и два worker (статусы обменов и outbox уведомлений).
Вторая копия процесса обмена недопустима: два клиента long polling с одним токеном бота конфликтуют.

Бот поддержки — другой процесс из папки `support-bot/`. Обмен его не импортирует и не запускает.
Процесс читает ту же `DATABASE_URL` и заявки не меняет. Свой токен: `SUPPORT_BOT_TOKEN`, пароль админа: `SUPPORT_ADMIN_PASSWORD`.
Падение поддержки обмен не останавливает. На сервере оба процесса стартуют вместе с базой.

Redis, входящий webhook статусов и публичный HTTPS в этот этап не входят.

## Две базы

Ноутбук и сервер — разные базы.

Ноутбучная лежит в томе Docker. Пока том не удалить командой с флагом `-v`, старые заявки на месте.
До выезда на сервер с неё снимается один файл `pg_dump` в `~/changenow-local-dump/`, вне репозитория.
Этот файл в git не класть и на сервер как рабочую базу не заливать. Посмотреть старые записи позже: `npm run db:up` и подключение к `127.0.0.1:5432`.

Серверная база пустая. Её создаёт `prisma migrate deploy` внутри контейнера обмена.
Новые заявки пишутся в том Docker `postgres_data` проекта `changenow-exchange-prod`, на диске VPS.
Порт 5432 наружу не публикуется.

Диск 40 ГБ — это весь диск машины. На нём файлы Postgres, несколько ночных дампов, образы Docker, логи с пределом размера и файл подкачки 2 ГБ.
Сама база поначалу занимает мегабайты. Дампов хранится несколько последних, логи режутся.

## Сервер

Ubuntu 24.04 LTS. Ориентир машины: 2 vCPU, 4 ГБ RAM, 40 ГБ SSD.
На машине: Docker Engine и Docker Compose v2, пользователь `deploy` с sudo, часовой пояс UTC.
Node.js на хост не ставится: в образе Node.js 22.

Вход по паролю, без SSH-ключа. Клиенту передаётся пользователь `deploy` и его пароль.
`PasswordAuthentication yes`. После проверки входа `deploy` вход root по SSH выключается.
Фаервол открывает только SSH, без привязки к одному IP.

fail2ban ставится сразу. Тюрьма `sshd`: 5 неудач за 10 минут, бан на 1 час.
Если свой адрес забанится, разбан делается из веб-консоли хостера:

```bash
sudo fail2ban-client set sshd unbanip АДРЕС
```

Перезапуск сервера или контейнеров по cron не делается. Упавший контейнер поднимает Docker (`restart: unless-stopped`).
Cron один: ночной дамп базы.

## Секреты и первый запуск

Секреты лежат только в `.env` на сервере, права `600`, владелец — `deploy`.
В образ и в git файл не попадает. Пароль базы — длинная строка из букв и цифр, без спецсимволов, чтобы не кодировать его в URL.
Нужны `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `DATABASE_URL`, `SUPPORT_BOT_TOKEN`, `SUPPORT_ADMIN_PASSWORD`.
`TELEGRAM_BOT_TOKEN` вписывается, когда он есть. Пустое значение оставляет контейнер обмена живым: HTTP и база работают, опрос Telegram включается после появления токена и одного пересоздания контейнера `app`.
`CHANGENOW_ENABLED=false`. `PUBLIC_BASE_URL` пустой, пока нет домена: кнопка «Открыть обмен» с телефона заработает следующим заходом.
`BACKUP_TARGET` пустой: копия остаётся на диске сервера.

Контакты `support@example.com` и `@your_support` в боте обмена остаются, пока клиент не даст рабочие.

Порядок старта одной командой `docker compose -f docker-compose.prod.yml up -d --build`:

1. Postgres без внешнего порта, healthcheck.
2. Контейнер обмена: `prisma migrate deploy`, затем `node dist/index.js`. Ручной SQL миграций отдельно не накатывают.
3. Контейнер поддержки стартует после того, как обмен отвечает `GET /health` со статусом 200. Миграции он не запускает.

Обновление версии: собрать образ заново и пересоздать контейнеры. Второй экземпляр обмена рядом не поднимать.
Остановка по `SIGTERM` уже обрабатывается: процесс закрывает бота, worker-ы и соединение с базой в пределах `SHUTDOWN_TIMEOUT_MS`.

## Сеть

Снаружи открыт SSH. Порт 5432 на сетевой карте закрыт, секция `ports` у Postgres в production-compose отсутствует.
Приложение ходит к базе по имени `postgres` в сети Compose.
Входящий HTTPS для long polling не нужен. `/health` остаётся внутри Docker-сети, порт 3000 наружу не публикуется.
Проверка здоровья:

```bash
docker compose -f docker-compose.prod.yml exec -T app \
  node -e "fetch('http://127.0.0.1:3000/health').then(async (response) => console.log(response.status, await response.text()))"
```

Ожидается строка со статусом `200` и `"database":"up"`. Иначе процесс ещё не готов или база недоступна.

## Бэкап

Каждую ночь `scripts/backup-db.sh` пишет `pg_dump` в формате custom в `/var/backups/changenow` и оставляет 7 последних файлов.
Том Docker — не замена дампу.

`BACKUP_TARGET` в `.env` на сервере:

- пусто — только локальный файл;
- `s3://bucket/prefix` — после локального файла скрипт вызывает `aws s3 cp` (команду `aws` ставят, когда бакет уже есть);
- `user@другой-сервер:/каталог` — `scp` в пакетном режиме. Cron пароль не спросит, к тому серверу позже нужен свой ключ. Это не вход на этот VPS: сюда по-прежнему заходят паролем.

Почта для дампа не используется: в файле адреса, memo и Telegram ID.

Проверка восстановления, один раз после первого старта:

```bash
./scripts/backup-db.sh --drill
```

Скрипт поднимает дамп во временную базу `changenow_restore`, сверяет имена миграций с `prisma/migrations` и удаляет временную базу.
Рабочую базу эта команда не затирает. Если `POSTGRES_DB` уже называется `changenow_restore`, скрипт останавливается.

## Наблюдение

Логи — stdout контейнера (Pino), у драйвера предел 10 МБ на три файла. Ключи, токен бота и приватные данные в логи не пишутся.
Отдельный сборщик метрик можно добавить позже.

## Команды на ноутбуке до сервера

Из каталога репозитория, локальный Postgres уже поднят (`npm run db:up`). Пароль в чат не копировать.

```bash
mkdir -p "$HOME/changenow-local-dump"
chmod 700 "$HOME/changenow-local-dump"
docker compose exec -T postgres pg_dump -U changenow -d changenow -Fc \
  > "$HOME/changenow-local-dump/changenow-local-$(date -u +%Y%m%dT%H%M%SZ).dump"
chmod 600 "$HOME/changenow-local-dump"/*.dump
```

Имя пользователя и базы должны совпадать с `POSTGRES_USER` и `POSTGRES_DB` в локальном `.env`.
Том после этого не удалять: `docker compose down` без `-v`.

## Команды на сервере

Их выполняют в терминале, по блокам. Пароли и токены в чат не отправляют.
Образ Ubuntu в панели хостера: 24.04 LTS. В чат присылается только IP.

Первый вход с ноутбука, пароль root из панели:

```bash
ssh root@IP
```

На сервере:

```bash
apt-get update && apt-get upgrade -y
timedatectl set-timezone UTC
adduser deploy
usermod -aG sudo deploy
```

Не закрывая сессию root, со второго терминала ноутбука проверить `ssh deploy@IP` и пароль `deploy`.
После успешного входа, снова под root:

```bash
printf '%s\n' 'PasswordAuthentication yes' 'KbdInteractiveAuthentication no' 'PermitRootLogin no' \
  > /etc/ssh/sshd_config.d/99-password-login.conf
sshd -t && systemctl reload ssh
apt-get install -y ufw fail2ban
ufw allow OpenSSH
ufw --force enable
printf '%s\n' '[sshd]' 'enabled = true' 'port = ssh' 'backend = systemd' 'maxretry = 5' 'findtime = 10m' 'bantime = 1h' \
  > /etc/fail2ban/jail.d/sshd.local
systemctl enable --now fail2ban
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
grep -q '/swapfile' /etc/fstab || printf '%s\n' '/swapfile none swap sw 0 0' >> /etc/fstab
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
  "$(dpkg --print-architecture)" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker deploy
mkdir -p /var/backups/changenow
chown deploy:deploy /var/backups/changenow
chmod 700 /var/backups/changenow
```

Дальше сессия `deploy`. Если репозиторий приватный, GitHub спросит логин и токен чтения. Токен в репозиторий и в чат не класть.

```bash
git clone https://github.com/itSpecialWork/changebot.git
cd changebot
cp .env.example .env
chmod 600 .env
nano .env
```

В `.env` заменить пароль базы в `POSTGRES_PASSWORD` и в `DATABASE_URL` на одну и ту же строку из букв и цифр.
`DATABASE_URL` на этом шаге может указывать на `127.0.0.1`: compose для контейнеров подставляет хост `postgres` сам.
Вписать `SUPPORT_BOT_TOKEN` и `SUPPORT_ADMIN_PASSWORD`. `CHANGENOW_ENABLED=false`, `PUBLIC_BASE_URL` и `BACKUP_TARGET` оставить пустыми.
Токен обмена вписать, если он уже есть.

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
./scripts/backup-db.sh --drill
```

Ночной дамп, под пользователем `deploy`:

```bash
crontab -e
```

Строка:

```cron
15 3 * * * cd /home/deploy/changebot && ./scripts/backup-db.sh >> /var/backups/changenow/backup.log 2>&1
```

Когда появится токен бота обмена, его вписывают в `.env` и пересоздают один контейнер:

```bash
docker compose -f docker-compose.prod.yml up -d --force-recreate --no-deps app
```

Второй контейнер обмена этой командой не появляется.
