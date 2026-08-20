import { useState } from "react";
import { CheckIcon, CopyIcon } from "./icons";

export const CopyCode = ({ children }: { children: string }) => {
  const [copied, setCopied] = useState<boolean>(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 1000);
  };

  return (
    <div className="inline-flex items-center gap-2 bg-surface-2 px-2 py-1 rounded-md relative">
      <pre className="p-0 m-0 text-ink-2">{children}</pre>
      <button
        onClick={handleCopy}
        className="p-0 bg-transparent border-0 outline-0 cursor-pointer"
      >
        {copied ? (
          <CheckIcon className="size-4 text-accent-hover" />
        ) : (
          <CopyIcon className="size-4 text-ink-2" />
        )}
      </button>
    </div>
  );
};
