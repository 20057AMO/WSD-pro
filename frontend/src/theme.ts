/**
 * theme.ts — dark/light theme helpers.
 * The active theme is stored in localStorage ('wsd.theme') and applied as
 * <html data-theme="light|dark">. index.html applies the saved value before
 * first paint so there is no flash of the wrong theme.
 */
export type Theme = 'dark' | 'light';

export function getTheme(): Theme {
  try {
    return localStorage.getItem('wsd.theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem('wsd.theme', theme);
  } catch { /* storage unavailable */ }
  if (theme === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'light' ? 'dark' : 'light';
  setTheme(next);
  return next;
}

export const PW_LABELS = ['Too short', 'Weak', 'Okay', 'Good', 'Strong'];
export const PW_COLORS = ['var(--red)', 'var(--red)', 'var(--yellow)', 'var(--green)', 'var(--green)'];

/** Simple password strength heuristic (0-4): length plus character variety. */
export function passwordStrength(pw: string): number {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 6) score += 1;
  if (pw.length >= 10) score += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
  else if (/\d/.test(pw) && pw.length >= 8) score += 1;
  if (/[^A-Za-z0-9]/.test(pw)) score += 1;
  return Math.min(score, 4);
}
