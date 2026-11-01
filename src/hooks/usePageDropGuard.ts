import { useEffect } from 'react';

/** Import screens: a file dropped outside the drop zone must not make the browser open it and leave the app. */
export function usePageDropGuard(): void {
  useEffect(() => {
    const stop = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);
}
