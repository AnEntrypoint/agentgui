#!/usr/bin/env node
/**
 * Patch script to fix Windows path duplication issue in fsbrowse
 * and sync fsbrowse styling with AgentGUI dark mode theme
 * Fixes: Error ENOENT: no such file or directory, scandir 'C:\C:\dev'
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fsbrowsePath = path.join(__dirname, '..', 'node_modules', 'fsbrowse', 'index.js');

if (!fs.existsSync(fsbrowsePath)) {
  console.warn('[PATCH] fsbrowse not found, skipping patch');
  process.exit(0);
}

try {
  let content = fs.readFileSync(fsbrowsePath, 'utf8');

  // Check if patch is already applied
  if (content.includes('sanitizedIsAbsoluteOnDrive')) {
    console.log('[PATCH] fsbrowse Windows path fix already applied');
    process.exit(0);
  }

  // Replace the makeResolver function with the fixed version
  const oldMakeResolver = `function makeResolver(baseDir) {
  return function resolveWithBaseDir(relPath) {
    const sanitized = sanitizePath(relPath);
    const fullPath = path.resolve(baseDir, sanitized);
    if (!fullPath.startsWith(baseDir)) {
      return { ok: false, error: 'EPATHINJECTION' };
    }
    return { ok: true, path: fullPath };
  };
}`;

  const newMakeResolver = `function makeResolver(baseDir) {
  const normalizedBase = path.normalize(baseDir);
  const baseDriveLetter = normalizedBase.match(/^[A-Z]:/i)?.[0];

  return function resolveWithBaseDir(relPath) {
    const sanitized = sanitizePath(relPath);
    let fullPath;

    // Extract drive letter from both paths to check for same-drive duplication on Windows
    const sanitizedDriveLetter = sanitized.match(/^[A-Z]:/i)?.[0];
    const sanitizedIsAbsoluteOnDrive = /^[A-Z]:/i.test(sanitized);

    // If both paths are on the same Windows drive, strip the drive letter from relPath
    // to avoid duplication like C:\\C:\\dev
    if (baseDriveLetter && sanitizedIsAbsoluteOnDrive && sanitizedDriveLetter === baseDriveLetter) {
      // Remove drive letter and leading slashes to make it relative
      let relativePath = sanitized;
      if (/^[A-Z]:/i.test(relativePath)) {
        relativePath = relativePath.substring(2);
        if (relativePath[0] === '/' || relativePath[0] === String.fromCharCode(92)) relativePath = relativePath.substring(1);
      }
      fullPath = path.resolve(normalizedBase, relativePath);
    } else {
      fullPath = path.resolve(normalizedBase, sanitized);
    }

    // Normalize for consistent comparison
    const normalizedFullPath = path.normalize(fullPath);
    const normalizedComparisonBase = path.normalize(normalizedBase);

    // Check path injection - convert backslashes to forward slashes for comparison
    const normalizedCheck = normalizedFullPath.replace(/\\\\/g, '/');
    const normalizedBaseCheck = normalizedComparisonBase.replace(/\\\\/g, '/');

    if (!normalizedCheck.startsWith(normalizedBaseCheck)) {
      return { ok: false, error: 'EPATHINJECTION' };
    }
    return { ok: true, path: normalizedFullPath };
  };
}`;

  if (content.includes(oldMakeResolver)) {
    content = content.replace(oldMakeResolver, newMakeResolver);
    fs.writeFileSync(fsbrowsePath, content, 'utf8');
    console.log('[PATCH] fsbrowse Windows path fix applied successfully');
  } else {
    console.warn('[PATCH] Could not find makeResolver function to patch');
  }
} catch (err) {
  console.error('[PATCH] Error applying fsbrowse patch:', err.message);
  process.exit(1);
}

// Patch fsbrowse CSS for dark mode theme sync
const fsbrowseCSSPath = path.join(__dirname, '..', 'node_modules', 'fsbrowse', 'public', 'style.css');

if (fs.existsSync(fsbrowseCSSPath)) {
  try {
    let cssContent = fs.readFileSync(fsbrowseCSSPath, 'utf8');

    // Check if dark mode CSS is already patched
    if (cssContent.includes('html.dark {')) {
      console.log('[PATCH] fsbrowse dark mode CSS already patched');
    } else {
      // Inject dark mode CSS rules
      const darkModeCSS = `/* Light mode - explicit */
html.light {
  --primary: #3b82f6;
  --primary-dark: #2563eb;
  --secondary: #6b7280;
  --border: #e5e7eb;
  --bg: #ffffff;
  --bg-alt: #f9fafb;
  --text: #111827;
  --text-light: #6b7280;
  --danger: #ef4444;
}

/* Dark mode - explicit, matches AgentGUI grey dark theme */
html.dark {
  --primary: #737373;
  --primary-dark: #525252;
  --secondary: #a3a3a3;
  --border: #333333;
  --bg: #1a1a1a;
  --bg-alt: #242424;
  --text: #e5e5e5;
  --text-light: #a3a3a3;
  --danger: #ef4444;
}

/* Fallback: media query for dark mode preference */
@media (prefers-color-scheme: dark) {
  :root:not(.light) {
    --primary: #60a5fa;
    --primary-dark: #3b82f6;
    --secondary: #9ca3af;
    --border: #374151;
    --bg: #111827;
    --bg-alt: #1f2937;
    --text: #f3f4f6;
    --text-light: #9ca3af;
    --danger: #f87171;
  }
}`;

      // Find the closing brace of :root and insert after it
      cssContent = cssContent.replace(
        /:root \{[\s\S]*?\}\s*@media/,
        match => match.replace('@media', darkModeCSS + '\n@media')
      );

      fs.writeFileSync(fsbrowseCSSPath, cssContent, 'utf8');
      console.log('[PATCH] fsbrowse dark mode CSS patched successfully');
    }
  } catch (err) {
    console.warn('[PATCH] Could not patch fsbrowse CSS:', err.message);
  }
}

// Patch fsbrowse app.js for theme sync
const fsbrowseAppJSPath = path.join(__dirname, '..', 'node_modules', 'fsbrowse', 'public', 'app.js');

if (fs.existsSync(fsbrowseAppJSPath)) {
  try {
    let appContent = fs.readFileSync(fsbrowseAppJSPath, 'utf8');

    // Ensure postMessage theme listener is present (storage events don't fire in same-window iframes)
    if (appContent.includes('theme-change')) {
      console.log('[PATCH] fsbrowse postMessage theme sync already present');
    } else if (appContent.includes('setupThemeSync')) {
      // setupThemeSync exists but lacks postMessage support - inject it
      appContent = appContent.replace(
        "    // Watch for storage changes from other tabs/windows\n    window.addEventListener('storage', e => {\n      if (e.key === 'gmgui-theme') syncTheme();\n    });",
        "    // Watch for storage changes from other tabs/windows\n    window.addEventListener('storage', e => {\n      if (e.key === 'gmgui-theme') syncTheme();\n    });\n\n    // Watch for postMessage from parent window (same-window iframes don't receive storage events)\n    window.addEventListener('message', e => {\n      if (e.data && e.data.type === 'theme-change' && e.data.theme) syncTheme(e.data.theme);\n    });"
      );
      // Also make syncTheme accept an explicit theme argument
      appContent = appContent.replace(
        'const syncTheme = () => {\n      const theme = localStorage.getItem(\'gmgui-theme\') ||',
        'const syncTheme = (theme) => {\n      theme = theme || localStorage.getItem(\'gmgui-theme\') ||'
      );
      fs.writeFileSync(fsbrowseAppJSPath, appContent, 'utf8');
      console.log('[PATCH] fsbrowse postMessage theme sync injected');
    } else {
      // No setupThemeSync at all - inject full method
      const themeSyncMethod = `
  setupThemeSync() {
    // Sync theme from parent window/localStorage if available
    const syncTheme = (theme) => {
      theme = theme || localStorage.getItem('gmgui-theme') ||
              (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      document.documentElement.className = theme;
      document.documentElement.setAttribute('data-theme', theme);
    };

    syncTheme();

    // Watch for storage changes from other tabs/windows
    window.addEventListener('storage', e => {
      if (e.key === 'gmgui-theme') syncTheme();
    });

    // Watch for postMessage from parent window (same-window iframes don't receive storage events)
    window.addEventListener('message', e => {
      if (e.data && e.data.type === 'theme-change' && e.data.theme) syncTheme(e.data.theme);
    });

    // Watch for media query changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme);
  },`;

      appContent = appContent.replace(
        'async init() {',
        'async init() {\n    this.setupThemeSync();'
      );
      appContent = appContent.replace(
        'api(path) {\n    return `${this.basePath}${path}`;\n  },',
        'api(path) {\n    return `${this.basePath}${path}`;\n  },' + themeSyncMethod
      );

      fs.writeFileSync(fsbrowseAppJSPath, appContent, 'utf8');
      console.log('[PATCH] fsbrowse theme sync patched successfully');
    }
  } catch (err) {
    console.warn('[PATCH] Could not patch fsbrowse app.js:', err.message);
  }
}
