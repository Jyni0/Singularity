import { cx } from "../cx.u";
import { Button } from "./Button.c";

/** Inline "Delete X? [Delete] [Cancel]" — a list row turns into the question. */
export function ConfirmBar({
  message,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
  busy,
  className,
}: {
  message: React.ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex items-center gap-2 rounded-xl border border-[var(--diff-del)]/40 bg-[var(--diff-del)]/10 px-2.5 py-1.5 text-[12.5px] text-[var(--text-main)]",
        className,
      )}
    >
      <span className="min-w-0 flex-1 truncate">{message}</span>
      <Button variant="danger" size="sm" onClick={onConfirm} disabled={busy}>
        {confirmLabel}
      </Button>
      <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
    </div>
  );
}
