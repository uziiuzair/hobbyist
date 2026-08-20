import { InputHTMLAttributes } from "react";
import { SearchIcon } from "./icons";

export const Search = (props: React.InputHTMLAttributes<HTMLInputElement>) => {
  const { className, ...rest } = props;

  return (
    <div className="w-full flex items-center px-4 border bottom-px border-line bg-surface-2 text-ink rounded-md">
      <SearchIcon className="size-4" />
      <input
        type="search"
        className="w-full grow py-3 px-5 rounded-md outline-none border-0 bg-transparent text-sm "
        {...rest}
      />
    </div>
  );
};
