// Theme management for dark/light mode
class ThemeManager {
  constructor() {
    this.THEME_KEY = 'gmgui-theme';
    this.SYSTEM_DARK_MODE = window.matchMedia('(prefers-color-scheme: dark)');
    this.init();
  }

  init() {
    // Load saved theme or use system preference
    const savedTheme = localStorage.getItem(this.THEME_KEY);
    const prefersDark = this.SYSTEM_DARK_MODE.matches;

    if (savedTheme) {
      this.setTheme(savedTheme);
    } else {
      // Use system preference
      this.setTheme(prefersDark ? 'dark' : 'light');
    }

    // Listen for system theme changes
    this.SYSTEM_DARK_MODE.addEventListener('change', (e) => {
      const savedTheme = localStorage.getItem(this.THEME_KEY);
      // Only auto-switch if user hasn't manually set a preference
      if (!savedTheme) {
        this.setTheme(e.matches ? 'dark' : 'light');
      }
    });

    // Setup theme toggle button
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
      themeToggle.addEventListener('click', () => this.toggleTheme());
    }
  }

  setTheme(theme) {
    if (theme !== 'dark' && theme !== 'light') {
      theme = 'light';
    }

    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(theme);
    localStorage.setItem(this.THEME_KEY, theme);
    this.updateThemeIcon(theme);

    // Notify embedded iframes (storage events don't fire in same window)
    const msg = { type: 'theme-change', theme };
    document.querySelectorAll('iframe').forEach(iframe => {
      try { iframe.contentWindow.postMessage(msg, '*'); } catch (_) {}
    });
  }

  toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    this.setTheme(newTheme);
  }

  updateThemeIcon(theme) {
    const icon = document.querySelector('.theme-icon');
    if (icon) {
      icon.textContent = theme === 'dark' ? '☀️' : '🌙';
    }
  }

  getCurrentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'light';
  }
}

// Initialize theme manager when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.themeManager = new ThemeManager();
  });
} else {
  window.themeManager = new ThemeManager();
}
