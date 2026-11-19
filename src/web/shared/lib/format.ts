import { getLanguage } from '../i18n/store';

/** When something happened, short enough for a card and exact enough to trust. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(getLanguage(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatNumber(value: number, digits: number): string {
  return new Intl.NumberFormat(getLanguage(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  }).format(value);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${formatNumber(bytes, 0)} B`;
  if (bytes < 1024 * 1024) return `${formatNumber(Math.round(bytes / 1024), 0)} kB`;
  return `${formatNumber(bytes / (1024 * 1024), 1)} MB`;
}
