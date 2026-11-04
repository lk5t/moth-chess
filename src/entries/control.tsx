import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/theme.css';
import { ControlApp } from '@/control/ControlApp';

createRoot(document.getElementById('root')!).render(<StrictMode><ControlApp /></StrictMode>);
