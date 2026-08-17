import { useState, useEffect, useCallback } from 'preact/hooks';
import { antiTranslations, type AntiLang, type AntiT } from '../i18n/antigravity';

const STORAGE_KEY = 'wsd.lang';

function detectInitial(): AntiLang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'ar' || stored === 'en') return stored;
  } catch { /* ignore */ }
  return navigator.language.startsWith('ar') ? 'ar' : 'en';
}

export function useLanguage() {
  const [lang, setLangState] = useState<AntiLang>(detectInitial);

  const setLang = useCallback((l: AntiLang) => {
    setLangState(l);
    try { localStorage.setItem(STORAGE_KEY, l); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  }, [lang]);

  const t: AntiT = antiTranslations[lang];

  return { lang, setLang, t, isArabic: lang === 'ar' };
}
