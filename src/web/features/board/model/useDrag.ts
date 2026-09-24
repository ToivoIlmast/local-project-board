import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { indexAt, type CardBox } from './dnd';

export interface DragState {
  id: string;
  status: string;
  /** Where the card would land in that column. */
  index: number;
}

export interface DragOptions {
  onDrop: (id: string, status: string, index: number) => void;
}

/** How far the pointer must travel before a press becomes a drag rather than a click. */
const THRESHOLD_PX = 4;

/**
 * Dragging with pointer events and no library: press, move, drop. The position it reports is
 * a column and a place in it — what the server needs to compute the rank (ADR-0011).
 */
export function useDrag({ onDrop }: DragOptions) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const columnsRef = useRef(new Map<string, HTMLElement>());
  const armedRef = useRef<{ id: string; x: number; y: number } | null>(null);
  /** Set once the press has travelled far enough to be a drag rather than a click. */
  const draggingRef = useRef(false);

  const registerColumn = useCallback(
    (status: string) => (element: HTMLElement | null) => {
      if (element) columnsRef.current.set(status, element);
      else columnsRef.current.delete(status);
    },
    [],
  );

  const positionOf = useCallback((id: string, x: number, y: number): DragState | null => {
    for (const [status, element] of columnsRef.current) {
      const box = element.getBoundingClientRect();
      if (x < box.left || x > box.right) continue;
      const boxes: CardBox[] = Array.from(
        element.querySelectorAll<HTMLElement>('[data-task-id]'),
      ).map((card) => {
        const rect = card.getBoundingClientRect();
        return { id: card.dataset['taskId'] ?? '', top: rect.top, height: rect.height };
      });
      return { id, status, index: indexAt(boxes, y, id) };
    }
    return null;
  }, []);

  const onPointerDown = useCallback(
    (id: string, event: ReactPointerEvent<HTMLElement>) => {
      // Only a plain press on the card itself: a click on the title or the menu is not a drag.
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest('button')) return;
      armedRef.current = { id, x: event.clientX, y: event.clientY };

      const element = event.currentTarget;
      const move = (moving: PointerEvent): void => {
        const start = armedRef.current;
        if (!start) return;
        const far =
          Math.abs(moving.clientX - start.x) > THRESHOLD_PX ||
          Math.abs(moving.clientY - start.y) > THRESHOLD_PX;
        if (!far && !draggingRef.current) return;
        draggingRef.current = true;
        setDrag(positionOf(start.id, moving.clientX, moving.clientY));
      };
      const up = (ending: PointerEvent): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const start = armedRef.current;
        const dragged = draggingRef.current;
        armedRef.current = null;
        draggingRef.current = false;
        setDrag(null);
        if (!start || !dragged) return;
        const landed = positionOf(start.id, ending.clientX, ending.clientY);
        if (landed) onDrop(landed.id, landed.status, landed.index);
      };

      element.setPointerCapture?.(event.pointerId);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [onDrop, positionOf],
  );

  return { drag, onPointerDown, registerColumn };
}
