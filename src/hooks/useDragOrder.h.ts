import { useEffect, useRef, useState } from "react";

/**
 * Local order for a drag-to-reorder list (motion's Reorder). While a drag is
 * in flight the list follows the pointer; on drop the new order is committed
 * once. `suppressClick` swallows the click a drop would otherwise fire on
 * the row under the pointer.
 */
export function useDragOrder<T extends { id: string }>(items: T[], onCommit: (ids: string[]) => void) {
  const [order, setOrder] = useState(items);
  const dragging = useRef(false);
  const justDropped = useRef(false);
  const orderRef = useRef(order);
  orderRef.current = order;

  // Follow outside changes (adds, deletes, reloads) unless a drag is live.
  useEffect(() => {
    if (!dragging.current) setOrder(items);
  }, [items]);

  const onDragStart = () => {
    dragging.current = true;
    // Set now: motion reports the drag end a frame after the click fires.
    justDropped.current = true;
  };

  const onDragEnd = () => {
    dragging.current = false;
    setTimeout(() => (justDropped.current = false), 80);
    const ids = orderRef.current.map((x) => x.id);
    if (ids.join("\n") !== items.map((x) => x.id).join("\n")) onCommit(ids);
  };

  const suppressClick = (e: React.MouseEvent) => {
    if (justDropped.current) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return { order, setOrder, onDragStart, onDragEnd, suppressClick };
}
