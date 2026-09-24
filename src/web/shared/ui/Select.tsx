import type { SelectHTMLAttributes } from 'react';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: readonly string[];
}

export function Select({ options, className, ...rest }: SelectProps) {
  return (
    <select className={['input', 'select', className].filter(Boolean).join(' ')} {...rest}>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}
