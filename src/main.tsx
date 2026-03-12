import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

window.onerror = (message, source, lineno, colno, error) => {
  console.error('Global Error:', message, 'at', source, lineno, colno, error);
};

window.onunhandledrejection = (event) => {
  console.error('Unhandled Rejection:', event.reason);
};

createRoot(document.getElementById('root')!).render(
  <App />
);
