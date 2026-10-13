import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { captureInstallPrompt } from './lib/install';
import { captureGlobalErrors } from './lib/errors';
import './styles.css';

// Must run before React: the browser fires this once, early.
captureInstallPrompt();
captureGlobalErrors();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
