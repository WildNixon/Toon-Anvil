/**
 * Sandboxed HTML scraper.
 *
 * Homebrew pages are hand-written HTML that may BUILD THEIR CONTENT AT RUNTIME.
 * The Warrior of the Fool page, for instance, holds its entire d20 Fool's
 * Fortune table in a JS array and renders it on load - a static DOMParser pass
 * sees an empty <div id="table"> and silently loses the most important part of
 * the subclass.
 *
 * So: load the page into an iframe with `sandbox="allow-scripts"`, let it run
 * its own JS exactly as a browser would, then have an injected collector
 * serialise the finished DOM and postMessage it back.
 *
 * Security: the sandbox has allow-scripts but NOT allow-same-origin, so the
 * frame is an opaque origin - it cannot touch our DOM, storage, cookies or
 * network credentials. The HTML it returns is parsed inertly with DOMParser,
 * which never executes scripts. At no point is untrusted code evaluated in the
 * app's origin.
 */

const COLLECTOR = `
<script>
(function () {
  function send() {
    try {
      parent.postMessage({
        __toonAnvil: 'scrape',
        title: document.title || '',
        html: document.body ? document.body.innerHTML : '',
        text: document.body ? document.body.innerText : ''
      }, '*');
    } catch (err) {
      parent.postMessage({ __toonAnvil: 'error', message: String(err) }, '*');
    }
  }
  // Let the page's own scripts run first. Deliberately timer-based, NOT
  // requestAnimationFrame: a frame that isn't being rendered produces no
  // animation frames, so an rAF callback here can simply never fire.
  var sent = false;
  function ready() {
    if (sent) return;
    sent = true;
    setTimeout(send, 150);
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') ready();
  else document.addEventListener('DOMContentLoaded', ready);
  window.addEventListener('load', ready);
}());
<\/script>
`;

/**
 * Render `html` in a sandboxed frame and return the DOM after its scripts ran.
 *
 * @param {string} html raw file contents
 * @param {number} timeout ms before giving up and falling back
 * @returns {Promise<{doc: Document, title: string, text: string, ranScripts: boolean}>}
 */
export function scrape(html, { timeout = 6000 } = {}) {
  return new Promise((resolve) => {
    const source = String(html);
    // Neutralise anything that would try to escape the frame or phone home.
    const prepared = injectCollector(source);

    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('aria-hidden', 'true');
    // Offscreen, but NOT visibility:hidden and NOT display:none - a frame that
    // isn't rendered gets no animation frames and heavily throttled timers,
    // which is enough to stop a page's own load-time rendering from running.
    frame.style.cssText =
      'position:fixed;left:-10000px;top:0;width:1200px;height:2400px;'
      + 'border:0;opacity:0;pointer-events:none;';

    let settled = false;
    const finish = (payload, ranScripts) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      frame.remove();
      const parser = new DOMParser();
      // Parsing a string with DOMParser never runs scripts - inert by spec.
      const doc = payload?.html
        ? parser.parseFromString(`<body>${payload.html}</body>`, 'text/html')
        : parser.parseFromString(source, 'text/html');
      resolve({
        doc,
        title: payload?.title || doc.title || '',
        text: payload?.text || doc.body?.textContent || '',
        ranScripts,
      });
    };

    const onMessage = (ev) => {
      if (ev.source !== frame.contentWindow) return;
      const data = ev.data;
      if (!data || data.__toonAnvil !== 'scrape') return;
      finish(data, true);
    };

    window.addEventListener('message', onMessage);
    // Fall back to a plain static parse rather than failing the import: a page
    // with no scripts, or one that throws, is still worth ingesting.
    const timer = setTimeout(() => finish(null, false), timeout);

    frame.srcdoc = prepared;
    document.body.append(frame);
  });
}

function injectCollector(html) {
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${COLLECTOR}</body>`);
  }
  return html + COLLECTOR;
}

/** Read a File/Blob as text, then scrape it. */
export async function scrapeFile(file) {
  const text = await file.text();
  const result = await scrape(text);
  return { ...result, filename: file.name, raw: text };
}
