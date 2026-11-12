export type Theme = 'light' | 'dark';

const THEME_KEY = 'wdcc:theme';

export function readTheme(): Theme {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Use the system preference when storage is unavailable.
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  window.dispatchEvent(new Event('wdcc-theme-change'));
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // The current tab still gets the selected theme.
  }
}
