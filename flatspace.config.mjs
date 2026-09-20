import { createRequire } from 'module';

var require = createRequire(import.meta.url);
var module = { exports: {} };

export default {
  outDir: 'dist',
  contentDir: 'site/content',
  theme: './site/theme.mjs',
};
