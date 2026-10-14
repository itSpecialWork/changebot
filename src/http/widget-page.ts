import { Router } from 'express';

/** Путь страницы с официальной встройкой виджета. */
export const WIDGET_PAGE_PATH = '/widget';

/**
 * Адрес виджета ChangeNOW. Сам по себе это только первый экран:
 * кнопка Exchange сообщает родительской странице о следующем шаге.
 * `link_id` — публичный идентификатор встройки, не ключ API.
 */
export const WIDGET_EMBED_URL =
  'https://changenow.io/embeds/exchange-widget/v2/widget.html?amount=1&amountFiat=1500&backgroundColor=FFFFFF&darkMode=false&from=usdttrc20&fromFiat=eur&horizontal=false&isFiat&lang=en-US&link_id=782584e7ba7d59&locales=true&logo=false&primaryColor=00C26F&to=usdttrc20&toFiat=eth&toTheMoon=true';

const STEPPER_CONNECTOR_URL = 'https://changenow.io/embeds/exchange-widget/v2/stepper-connector.js';

/** Адрес нашей страницы на публичном https. */
export function widgetPageUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl}${WIDGET_PAGE_PATH}`;
}

/** Адрес для кнопки на этой машине. `0.0.0.0` браузер не открывает. */
export function localWidgetPageUrl(host: string, port: number): string {
  const hostname = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const formatted =
    hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return `http://${formatted}:${port}${WIDGET_PAGE_PATH}`;
}

function widgetPageHtml(): string {
  const src = WIDGET_EMBED_URL.replaceAll('&', '&amp;');
  return `<!DOCTYPE html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Обмен</title>
    <style>
      html,
      body {
        margin: 0;
        background: #ffffff;
      }
    </style>
  </head>
  <body>
    <iframe
      id="iframe-widget"
      src="${src}"
      style="height: 356px; width: 100%; border: none"
    ></iframe>
    <script defer src="${STEPPER_CONNECTOR_URL}"></script>
  </body>
</html>
`;
}

export function createWidgetPageRouter(): Router {
  const router = Router();

  router.get(WIDGET_PAGE_PATH, (_req, res) => {
    res.status(200).type('html').set('X-Content-Type-Options', 'nosniff').send(widgetPageHtml());
  });

  return router;
}
