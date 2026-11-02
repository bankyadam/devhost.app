import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { createDemoTransport } from './transport/demo';
import { createTauriTransport, insideTauri } from './transport/tauri';

// Inside the app: the Rust shell and the system ssh. In a plain browser (vite dev, screenshots): a read-only demo.
const makeTransport = insideTauri() ? createTauriTransport : createDemoTransport;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App makeTransport={makeTransport} view={location.hash === '#monitor' ? 'monitor' : 'main'} />
  </StrictMode>,
);
