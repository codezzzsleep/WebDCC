import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './App.js';
import './index.css';
import { applyTheme, readTheme } from './lib/theme.js';

performance.mark('wdcc:module');
applyTheme(readTheme());
const container = document.getElementById('root');
if (container === null) throw new Error('缺少 #root 容器');
createRoot(container).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
