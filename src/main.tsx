import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Keep these font imports in sync with .storybook/preview.tsx.
import '@fontsource/noto-sans-jp/400.css';
import '@fontsource/noto-sans-jp/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import './index.css';
import { Root } from './Root.tsx';
import { createGisAuth } from './lib/auth/gis.ts';
import { getLocalStorage } from './lib/storage.ts';

const storage = getLocalStorage();
// The real Google sign-in (GIS token model). Without VITE_GOOGLE_CLIENT_ID
// (.env.local) the status is 'unconfigured' and the app works locally only.
const auth = createGisAuth({
  clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined,
  storage,
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* No `client`: Root uses the fetch Drive client (real Drive API). */}
    <Root auth={auth} storage={storage} />
  </StrictMode>,
);
