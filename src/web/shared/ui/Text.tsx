import type { ReactNode } from 'react';

export interface TextProps {
  children: ReactNode;
  tone?: 'normal' | 'muted' | 'mono';
  as?: 'p' | 'span' | 'div';
}

export function Text({ children, tone = 'normal', as: Tag = 'p' }: TextProps) {
  return <Tag className={`text text--${tone}`}>{children}</Tag>;
}
