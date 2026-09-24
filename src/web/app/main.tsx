import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/ui/ui.css';
import './app.css';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('#root element is missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
