import type { SelectHTMLAttributes } from 'react';

export type SelectOption = string | { value: string; label: string };

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** A plain string is both the value and the text; an object says them apart. */
  options: readonly SelectOption[];
}

export function Select({ options, className, ...rest }: SelectProps) {
  return (
    <select className={['input', 'select', className].filter(Boolean).join(' ')} {...rest}>
      {options.map((option) => {
        const { value, label } =
          typeof option === 'string' ? { value: option, label: option } : option;
        return (
          <option key={value} value={value}>
            {label}
          </option>
        );
      })}
    </select>
  );
}
