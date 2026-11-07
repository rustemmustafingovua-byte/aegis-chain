# AEGIS Design System — v1.0

## Токены

| Токен | Значение | Где |
|---|---|---|
| `--bg` / `--bg2` | `#0b0e1a` / `#0f132e` | фон explorer + wallet |
| `--card` / `--line` | `#121832`…`#161c3d` / `#1e2547` | карточки, бордеры |
| `--acc` / `--acc2` | `#7c6bff` / `#a193ff` | primary CTA, ссылки, активные табы |
| `--cyan` / `--gold` | `#38e1ff` / `#ffbf5e` | вторичный акцент, badge |
| `--ok` / `--warn` / `--bad` | `#3dd68c` / `#ffb648` / `#ff6b6b` | статусы, вердикты shield |
| `--txt` / `--mut` | `#e8eaf6` / `#9aa3c7` | текст / вторичный |
| `--rad` / `--rad2` | `18px` / `12px` | карточки / поля |
| Типографика | Inter/system-ui; mono: ui-monospace | заголовки bold, адреса mono |
| Радиус кнопок | `12px`, pill-tabs `999px` | |
| Тени | `0 18–20px 50–60px rgba(0,0,0,.45)` | карточки, тосты |

## Explorer (`explorer/index.html`)

- Sticky header с высотой, версией и live-статусом
- Hero с тремя badge (PQ · anti-AI · mesh), KPI-карточки (высота, mempool+sparkline, supply, peers, цена)
- Поиск адреса → `aeg_getBalance`, copy-friendly mono, toast-уведомления
- Табы: Блоки, Swap, Stake, Governance, Node — всё live из `/api/state` (4с автообновление, пауза)
- Блоки: new-block flash, клик → модалка с JSON до 12k, hybrid-verify панель
- Swap: pool depth chip (base/quote/fee/shares), quote через `aeg_swapQuote`
- Доступность: контраст AA на тёмном, минимальный motion, `prefers-reduced-motion` уважается на wallet

## Wallet (`wallet-mobile/`)

- Mobile-first 480px, bottom nav (Кошелёк / Платёж / История / Щит), safe-area inset
- Passkey hero с shield-логотипом и gradient, баланс RU, copy address, сессия 60с индикатор
- Платёж: 4 поля (to, amount, intent, domain), intent preview via details, online/offline подписание, QR mesh-пакета (qrcode <900B payload), история в localStorage
- Щит tab: 6 проверок anti-AI checklist, incident playbook, эфемерные сессии
- PWA: `manifest.webmanifest` + `icon.svg`, theme `#0b0e1a`, display standalone

##_motion & принципы

- Никаких авто-анимаций ради анимаций; flash новых блоков — 0.3s
- Человек читает намерение: intent и домен всегда видны до подписи
- Невидимая работа безопасности — видимая: вердикты behavioral всегда в UI

## Что не трогаем

- Фирменный градиент щит→циан не меняем — узнаваемость
- `--acc` остаётся фиолетовым — совместимость с v0.7 explorer
