import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/theme.css';
import { PopupApp } from '@/popup/App';

createRoot(document.getElementById('root')!).render(<StrictMode><PopupApp /></StrictMode>);
