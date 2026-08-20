import { cn } from "../../utils/cn";
import { AlertTriangleIcon } from "./icons";

export const Alert = ({ className }: { className?: string }) => {
  return (
    <div
      className={cn(
        "w-full flex items-center gap-4 px-4 border bottom-px border-line bg-surface-2 text-ink rounded-lg py-3 relative",
        className,
      )}
    >
      <div className="size-9 flex items-center justify-center bg-red-900/50 rounded-full">
        <AlertTriangleIcon className="size-4 text-white" />
      </div>

      <div>
        <p className="text-ink font-bold">Exposed RDP Server</p>
        <p className="text-ink-3">
          Exposed Interface - ooozzy.com - Mar 3, 2026
        </p>
      </div>
    </div>
  );
};
