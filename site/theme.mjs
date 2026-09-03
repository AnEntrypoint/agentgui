// AnEntrypoint design-system theme for flatspace.
// Renders SDK chrome around home (landing) AND legacy docs/* pages
// (each rendered as an iframe of the original, preserving scripts/styles).

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const escapeJson = (obj) => JSON.stringify(obj)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(new RegExp('\\u2028', 'g'), '\\u2028').replace(new RegExp('\\u2029', 'g'), '\\u2029');

const SDK_URL = 'https://unpkg.com/anentrypoint-design@latest/dist/247420.js';
// Render-blocking CSS counterpart of SDK_URL so the kit base surface + .site-*
// classes paint BEFORE the module's installStyles() runs (no FOUC). All design
// content lives in the kit; this template carries no inline <style>.
const CSS_URL = 'https://unpkg.com/anentrypoint-design@latest/dist/247420.css';
const THIS_DIR = dirname(fileURLToPath(import.meta.url));

const landingClient = `
import { h, applyDiff, installStyles, components as C } from 'anentrypoint-design';
installStyles();
document.documentElement.classList.add('ds-247420');
const data = JSON.parse(document.getElementById('__site__').textContent);
const { site, nav, page } = data;

function Hero() {
  if (!page || !page.hero) return null;
  return C.Panel({
    class: 'site-panel',
    children: h('div', { class: 'site-hero' },
      C.Heading({ level: 1, class: 'site-hero-h', children: page.hero.heading || site.title }),
      page.hero.subheading ? C.Lede({ children: page.hero.subheading }) : null,
      page.hero.body ? h('p', { class: 'site-hero-body' }, page.hero.body) : null,
      (page.hero.badges && page.hero.badges.length) ? h('div', { class: 'site-chip-row' },
        ...page.hero.badges.map((b, i) => C.Chip({ key: 'b' + i, children: b.label }))
      ) : null,
      (page.hero.ctas && page.hero.ctas.length) ? h('div', { class: 'site-cta-row' },
        ...page.hero.ctas.map((c, i) => C.Btn({ key: 'c' + i, href: c.href, variant: c.primary ? 'primary' : 'default', children: c.label }))
      ) : null
    )
  });
}

function Features() {
  if (!page || !page.features || !page.features.items || !page.features.items.length) return null;
  const rows = page.features.items.map((it, i) => C.RowLink({
    key: 'f' + i,
    code: String(i + 1).padStart(2, '0'),
    title: it.name,
    sub: it.desc || '',
    meta: it.meta || '',
    href: it.href || '#'
  }));
  return C.Panel({
    title: page.features.heading || 'features',
    class: 'site-panel',
    children: rows
  });
}

function Quickstart() {
  if (!page || !page.quickstart || !page.quickstart.lines || !page.quickstart.lines.length) return null;
  const lineNodes = page.quickstart.lines.map((l, i) => {
    const isComment = l.kind === 'cmt';
    return h('div', { key: 'q' + i, class: 'cli' },
      h('span', { class: 'prompt' }, isComment ? '#' : '$'),
      h('span', { class: 'cmd' }, l.text)
    );
  });
  return C.Panel({
    title: page.quickstart.heading || 'quick start',
    class: 'site-panel',
    children: h('div', { class: 'site-cli' }, ...lineNodes)
  });
}

function Footer() {
  return h('footer', { class: 'site-footer' },
    h('span', { class: 'item' }, 'styled with '),
    h('a', { class: 'item', href: 'https://anentrypoint.github.io/design/' }, 'anentrypoint-design'),
    h('span', { class: 'item' }, '·'),
    h('a', { class: 'item', href: 'https://247420.xyz' }, '247420.xyz'),
    h('span', { class: 'spread' }),
    site.repo ? h('a', { class: 'item', href: site.repo }, 'source ->') : null
  );
}

const navItems = (nav && nav.links ? nav.links : []).map(l => [String(l.label || ''), l.href]);

const App = C.AppShell({
  topbar: C.Topbar({ brand: '247420', leaf: site.title || '', items: navItems }),
  crumb: C.Crumb({ trail: ['247420'], leaf: site.title || '' }),
  main: h('div', {}, Hero(), Features(), Quickstart()),
  status: Footer()
});
applyDiff(document.getElementById('app'), [App]);
`;

const embedClient = `
import { h, applyDiff, installStyles, components as C } from 'anentrypoint-design';
installStyles();
document.documentElement.classList.add('ds-247420');
const data = JSON.parse(document.getElementById('__site__').textContent);
const { site, nav, page } = data;
const navItems = (nav && nav.links ? nav.links : []).map(l => [String(l.label || ''), l.href]);

function Footer() {
  return h('footer', { class: 'site-footer' },
    h('span', { class: 'item' }, 'styled with '),
    h('a', { class: 'item', href: 'https://anentrypoint.github.io/design/' }, 'anentrypoint-design'),
    h('span', { class: 'item' }, '·'),
    h('a', { class: 'item', href: 'https://247420.xyz' }, '247420.xyz'),
    h('span', { class: 'spread' }),
    site.repo ? h('a', { class: 'item', href: site.repo }, 'source ->') : null
  );
}

const App = C.AppShell({
  topbar: C.Topbar({ brand: '247420', leaf: site.title || '', items: navItems }),
  crumb: C.Crumb({ trail: ['247420', site.title || ''], leaf: page.title || '' }),
  main: C.Panel({
    class: 'site-panel',
    children: h('iframe', {
      src: page.embedSrc,
      class: 'site-embed',
      title: page.title || ''
    })
  }),
  status: Footer()
});
applyDiff(document.getElementById('app'), [App]);
`;

const renderHtml = ({ site, nav, page, clientScript }) => `<!DOCTYPE html>
<html lang="en" class="ds-247420">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(page.title || site.title)}${site.tagline ? ' - ' + escapeHtml(site.tagline) : ''}</title>
  <meta name="description" content="${escapeHtml(page.description || site.description || site.tagline || site.title)}" />
  <script type="importmap">{"imports":{"anentrypoint-design":"${SDK_URL}"}}</script>
  <link rel="stylesheet" href="${CSS_URL}" />
</head>
<body>
  <div id="app"></div>
  <script type="application/json" id="__site__">${escapeJson({ site, nav, page })}</script>
  <script type="module">${clientScript}</script>
</body>
</html>
`;

export default {
  // Copy original docs/* into dist/_legacy/* so iframes can load them.
  assets: {
    '../docs/demo.html': '_legacy/demo.html',
    '../docs/screenshots': 'screenshots',
  },
  render: async (ctx) => {
    const site = ctx.readGlobal('site') || {};
    const nav = ctx.readGlobal('navigation') || { links: [] };
    const docs = ctx.read('pages').docs;
    const homeDoc = docs.find(p => p.id === 'home');
    if (!homeDoc) throw new Error('site/content/pages/home.yaml missing or has no id: home');

    const outputs = [{
      path: 'index.html',
      html: renderHtml({ site, nav, page: homeDoc, clientScript: landingClient })
    }];

    // Wrapped legacy pages: SDK chrome + iframe of original.
    const embeds = [
      { path: 'demo.html', title: 'demo', embedSrc: './_legacy/demo.html' },
    ];
    for (const e of embeds) {
      outputs.push({
        path: e.path,
        html: renderHtml({ site, nav, page: e, clientScript: embedClient })
      });
    }
    return outputs;
  }
};
