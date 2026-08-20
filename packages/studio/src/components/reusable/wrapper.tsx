import { cn } from "../../utils/cn";

export const Wrapper = ({
  wide = false,
  children,
}: {
  wide?: boolean;
  children?: React.ReactNode;
}) => {
  return (
    <div className={cn(" w-full mx-auto", wide ? " px-6" : "max-w-5xl")}>
      {children}
    </div>
  );
};
