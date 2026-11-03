import { useEffect, useState } from 'react';
import { safeStorage } from '../lib/storage.js';

/** Theme preference: system | light | dark, applied as data-theme on <html>. */
export function useTheme() {
  const [theme, setTheme] = useState(() => safeStorage.get('insight.theme') || 'system');
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
    safeStorage.set('insight.theme', theme);
  }, [theme]);
  return [theme, setTheme];
}
