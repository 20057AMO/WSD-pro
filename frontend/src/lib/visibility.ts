import { useState, useEffect } from 'preact/hooks';

/**
 * Hook that tracks the document visibility state.
 * Returns `true` when the page is visible, `false` when hidden.
 * Re-renders on every visibilitychange event.
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);

  useEffect(() => {
    const onVisChange = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisChange);
    return () => document.removeEventListener('visibilitychange', onVisChange);
  }, []);

  return visible;
}
