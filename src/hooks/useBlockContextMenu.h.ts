import { useEffect } from "react";

/**
 * Suppresses the default right-click menu for the whole window. A desktop app
 * should own its own menus rather than show Back / Reload / Inspect.
 */
export function useBlockContextMenu() {
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, []);
}
