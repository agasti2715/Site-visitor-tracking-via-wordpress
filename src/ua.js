// Small user-agent reader: enough to show browser / OS / device and to drop bots.

const BOT = /bot|crawl|spider|slurp|facebookexternalhit|embedly|quora link|whatsapp|telegrambot|preview|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python-requests|axios|go-http|java\/|httpclient|phantomjs|puppeteer|playwright|selenium/i;

export function isBot(ua) {
  return !ua || BOT.test(ua);
}

export function parseUa(ua = '') {
  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /OPR\/|Opera/.test(ua) ? 'Opera' :
    /SamsungBrowser/.test(ua) ? 'Samsung Internet' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Safari\//.test(ua) ? 'Safari' : 'Other';

  const os =
    /Windows/.test(ua) ? 'Windows' :
    /iPhone|iPad|iPod/.test(ua) ? 'iOS' :
    /Android/.test(ua) ? 'Android' :
    /Mac OS X|Macintosh/.test(ua) ? 'macOS' :
    /CrOS/.test(ua) ? 'ChromeOS' :
    /Linux/.test(ua) ? 'Linux' : 'Other';

  const device =
    /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? 'Tablet' :
    /Mobi|iPhone|Android/.test(ua) ? 'Mobile' : 'Desktop';

  return { browser, os, device };
}
