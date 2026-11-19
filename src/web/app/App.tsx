import { BoardProvider } from '../api/react';
import { BoardPage } from '../pages/BoardPage';
import { I18nProvider } from '../shared/i18n/index';

export function App() {
  return (
    <I18nProvider>
      <BoardProvider>
        <BoardPage />
      </BoardProvider>
    </I18nProvider>
  );
}
