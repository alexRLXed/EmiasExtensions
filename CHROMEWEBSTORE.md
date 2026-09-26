# Chrome Web Store Listing — Помощник переноса записи для emias.info

> Last Updated: 2026-09-06

## Store Listing

**Extension Name** [REQUIRED]
Помощник переноса записи для emias.info

**Short Description** [REQUIRED]
Помогает находить удобные слоты расписания и переносить активную запись к врачу на emias.info на ближайшее к желаемому время.

**Detailed Description** [REQUIRED]
Неофициальный персональный помощник для работы с порталом emias.info. Расширение помогает подобрать удобное время приёма среди освобождающихся талонов и перенести текущую запись на желаемое время.

Ключевые возможности:
- Быстрый просмотр доступных слотов расписания по вашей записи с автоматическим расчетом разницы с желаемым временем
- Интеллектуальный поиск ближайшего времени приёма (в рамках заданного окна: ±30 мин, ±1 час, весь день)
- Возможность поиска слотов как у текущего специалиста, так и среди всех доступных врачей специальности
- Режим авто-мониторинга для ожидания освобождающихся талонов при отмене другими пациентами
- Безопасные интервалы опроса (25-35 сек) без чрезмерной нагрузки на сервис
- Уведомления о переносе: звуковой сигнал в браузере и мгновенные сообщения в ваш личный Telegram-бот

Как пользоваться:
1. Откройте emias.info/app/einfo/ в браузере (где вы уже авторизованы)
2. Откройте окно расширения или нажмите на плавающий значок в правом нижнем углу
3. Выберите нужную запись и укажите желаемую дату и время
4. Нажмите «Найти слоты сейчас» для моментального выбора или «Запустить автоперенос» для отслеживания талонов

Конфиденциальность:
Расширение работает исключительно локально в вашем браузере. Ваши персональные данные, номер полиса ОМС и история посещений НЕ передаются на сторонние сервера и НЕ собираются разработчиком. Все сетевые вызовы выполняются напрямую между вашим браузером, порталом emias.info и вашим личным ботом в Telegram.

Дисклеймер:
Данное программное обеспечение является независимой разработкой и не связано с Департаментом здравоохранения города Москвы (ДЗМ), ГКУ ИАЦ в сфере здравоохранения или сервисом ЕМИАС.ИНФО.

**Category** [REQUIRED]
Productivity

**Single Purpose** [REQUIRED]
Помощь в подборе оптимального времени и переносе активных записей к врачу на портале emias.info.

**Primary Language** [REQUIRED]
Russian

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|---|---|---|---|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `icons/icon-128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 | ⬜ To be captured | Скриншот окна расширения с выбором времени |
| Screenshot 2 [RECOMMENDED] | 1280×800 | ⬜ To be captured | Скриншот виджета на странице emias.info |
| Screenshot 3 [RECOMMENDED] | 1280×800 | ⬜ To be captured | Скриншот уведомления в Telegram |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | |

## Permissions Justification

| Permission | Type | Justification |
|---|---|---|
| `storage` | permissions | Сохранение пользовательских настроек (желаемое время, допустимое окно, токен личного Telegram-бота) локально в браузере. |
| `tabs` | permissions | Определение активной вкладки emias.info для проверки доступности страницы и взаимодействия с формой переноса. |
| `alarms` | permissions | Управление фоновыми таймерами для безопасных интервалов проверки расписания. |
| `notifications` | permissions | Показ системного уведомления на рабочем столе при успешном переносе записи. |
| `https://emias.info/*` | host_permissions | Взаимодействие с API портала emias.info для чтения доступных слотов и отправки запроса на перенос записи. |
| `https://*.emias.info/*` | host_permissions | Обеспечение работы на поддоменах портала emias.info. |
| `https://api.telegram.org/*` | host_permissions | Отправка уведомлений об успешном переносе в личный Telegram-бот пользователя по официальному Bot API. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No.
Расширение не собирает и не отправляет пользовательские данные внешним сервисам. Все данные обрабатываются локально на устройстве пользователя.

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL**: `https://github.com/[username]/MoveAppointmentEmias/blob/main/PRIVACY.md` (или страница на GitHub Pages)

## Distribution

**Visibility**: Unlisted (Рекомендуется доступ по прямой ссылке) или Public
**Regions**: Russia
**Pricing**: Free

## Version History

| Version | Date | Changes | Status |
|---|---|---|---|
| 1.1.0 | 2026-09-06 | Первый релиз: поиск слотов, авто-снайпер, Telegram-уведомления | Draft |
