import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/theme.css';
import { SettingsApp } from '@/settings/SettingsApp';

createRoot(document.getElementById('root')!).render(<StrictMode><SettingsApp /></StrictMode>);
