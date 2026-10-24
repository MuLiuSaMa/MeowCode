import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from "react";
import "./Table.css";

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <table className={["mc-table", className ?? ""].filter(Boolean).join(" ")}>
      {children}
    </table>
  );
}

export function Th({
  children,
  className,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { children?: ReactNode }) {
  return (
    <th className={["mc-table__th", className ?? ""].filter(Boolean).join(" ")} {...rest}>
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { children?: ReactNode }) {
  return (
    <td className={["mc-table__td", className ?? ""].filter(Boolean).join(" ")} {...rest}>
      {children}
    </td>
  );
}
