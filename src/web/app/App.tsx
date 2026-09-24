import { BoardProvider } from '../api/react';
import { BoardPage } from '../pages/BoardPage';

export function App() {
  return (
    <BoardProvider>
      <BoardPage />
    </BoardProvider>
  );
}
