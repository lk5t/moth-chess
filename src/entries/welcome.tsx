import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/theme.css';
import { WelcomeApp } from '@/welcome/WelcomeApp';

createRoot(document.getElementById('root')!).render(<StrictMode><WelcomeApp /></StrictMode>);
