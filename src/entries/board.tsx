import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/theme.css';
import { BoardApp } from '@/board-app/App';

createRoot(document.getElementById('root')!).render(<StrictMode><BoardApp /></StrictMode>);
