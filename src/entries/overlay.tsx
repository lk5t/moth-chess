import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/theme.css';
import { OverlayApp } from '@/overlay-app/App';

createRoot(document.getElementById('root')!).render(<StrictMode><OverlayApp /></StrictMode>);
