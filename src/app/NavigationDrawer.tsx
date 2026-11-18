import { useLayoutEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

/** Native modal behavior keeps focus inside the drawer and restores it to the menu button. */
export default function NavigationDrawer({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-label="Navigation"
      className="fixed inset-0 m-0 h-[100dvh] max-h-none w-full max-w-none border-0 bg-transparent p-0 backdrop:bg-black/50"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="h-full w-fit">{children}</div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close navigation"
        className="absolute left-60 top-2 ml-2 flex h-11 w-11 items-center justify-center rounded-lg bg-slate-800 text-white"
      >
        <X size={20} strokeWidth={1.75} />
      </button>
    </dialog>
  );
}
