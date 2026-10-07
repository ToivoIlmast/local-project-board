import type { SelectHTMLAttributes } from 'react';

/** An option that cannot be chosen now says why elsewhere: next to the select, in its hint. */
export type SelectOption = string | { value: string; label: string; disabled?: boolean };

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** A plain string is both the value and the text; an object says them apart. */
  options: readonly SelectOption[];
}

export function Select({ options, className, ...rest }: SelectProps) {
  return (
    <select className={['input', 'select', className].filter(Boolean).join(' ')} {...rest}>
      {options.map((option) => {
        const { value, label, disabled } =
          typeof option === 'string' ? { value: option, label: option, disabled: false } : option;
        return (
          <option key={value} value={value} disabled={disabled === true}>
            {label}
          </option>
        );
      })}
    </select>
  );
}
