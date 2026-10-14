# Browser — iOS-браузер с DevTools как в Chrome

Обычный браузер (домашняя страница — Google) на WKWebView со встроенными
инструментами разработчика, которые открываются по **F12** — как в Chrome.

## Возможности

- Адресная строка: URL или поиск в Google, назад/вперёд, прогресс загрузки, pull-to-refresh.
- **F5** (или ⌘R) — обновляет только страницу. Приложение и открытая панель DevTools
  остаются на месте; **⇧F5 / Ctrl+F5 / ⌘⇧R** — обновление без кэша.
- **F12** (или ⌘⌥I / Ctrl+Shift+I, кнопка `</>` на панели) — открыть/закрыть DevTools.
- ⌘⌥J — консоль, ⌘⇧C — выбрать элемент на странице, ⌘L — адресная строка.
- Панель DevTools: снизу, справа или на весь экран; размер меняется перетаскиванием
  (двойной тап по полоске — развернуть).
- Меню: версия для ПК, поиск на странице, поделиться, очистка данных сайтов.

## Разделы DevTools

| Раздел | Что умеет |
|---|---|
| **Elements** | Живое DOM-дерево (shadow DOM, iframe), подсветка элемента на странице, режим «выбрать элемент», поиск по тексту/селектору/XPath, редактирование атрибутов, текста и HTML, удаление/дублирование/скрытие, копирование selector/JS path/XPath. Боковые вкладки **Styles** (правила CSS, вкл/выкл и правка свойств, `element.style`), **Computed**, **Layout** (box model), **Event Listeners**, **Properties**. |
| **Console** | console.log/info/warn/error/debug/table/group/dir/trace/count/time/assert, `%c` и форматирование, ошибки и необработанные промисы со стеком, раскрываемые объекты, выполнение JS (работает даже при строгом CSP), `await` верхнего уровня, история ↑/↓, автодополнение, `$0`, `$`, `$$`, `$x`, `copy()`, `inspect()`, `getEventListeners()`, фильтр и уровни, Preserve log. |
| **Sources** | Дерево ресурсов страницы, просмотр исходников с подсветкой и номерами строк, Pretty print `{ }`, поиск, переход к строке из консоли. |
| **Network** | fetch, XHR, WebSocket (с сообщениями), документ и ресурсы страницы; фильтры по типу, waterfall, заголовки, payload, preview (JSON-дерево/картинки), response, timing; копирование как cURL/fetch, экспорт HAR. |
| **Performance** | Web Vitals (TTFB, FCP, LCP, CLS, DCL, Load), разбивка навигации, ресурсы по типам, запись FPS и блокировок главного потока. |
| **Memory** | DOM-узлы, слушатели событий, хранилища, снимки и сравнение. |
| **Application** | Local/Session storage (правка/удаление), Cookies, IndexedDB, Cache storage, Manifest, Service workers, очистка данных сайта. |
| **Security** | HTTPS, цепочка сертификатов, смешанный контент, источники запросов. |

## Сборка

GitHub Actions (`.github/workflows/build-ipa.yml`) собирает проект на macOS при каждом push
и выкладывает **Browser-ipa** (zip с `Browser.ipa`) в артефакты запуска:
*Actions → Build IPA → последний запуск → Artifacts*.

IPA не подписан — установите через AltStore, Sideloadly, TrollStore и т.п.

Локально: `brew install xcodegen && xcodegen generate && open Browser.xcodeproj`.
