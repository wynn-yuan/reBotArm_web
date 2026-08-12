import { AppProvider } from './state/AppContext';
import { AppShell } from './components/layout/AppShell';

export function App() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}