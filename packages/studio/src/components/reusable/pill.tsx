export const Pill = ({ children }: { children?: React.ReactNode }) => {
  return (
    <span className="bg-surface-2 block px-2.5 py-0.5 text-sm rounded-full text-ink-2 border-line border">
      {children}
    </span>
  );
};
