import { readFileSync } from 'node:fs';

/**
 * Nobody has to look at a dark theme to know it can be read: the tokens the stylesheet
 * defines are pairs of colors, and how far apart a pair is can be computed (WCAG 2.x).
 */
const css = readFileSync('src/web/shared/ui/ui.css', 'utf8');

type Tokens = Record<string, string>;

function tokensIn(block: string): Tokens {
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((match) => [
      match[1] ?? '',
      match[2] ?? '',
    ]),
  );
}

const light = tokensIn(/:root\s*{([^}]*)}/.exec(css)?.[1] ?? '');
const dark = {
  ...light,
  ...tokensIn(/prefers-color-scheme:\s*dark\)\s*{\s*:root\s*{([^}]*)}/.exec(css)?.[1] ?? ''),
};

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => channel(parseInt(hex.slice(at, at + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [lighter = 0, darker = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/** A color laid over another at a given share, the way `color-mix` does it. */
function over(top: string, under: string, share: number): string {
  const mixed = [1, 3, 5].map((at) => {
    const t = parseInt(top.slice(at, at + 2), 16);
    const u = parseInt(under.slice(at, at + 2), 16);
    return Math.round(t * share + u * (1 - share))
      .toString(16)
      .padStart(2, '0');
  });
  return `#${mixed.join('')}`;
}

const TEXT = 4.5;
const CONTROL_EDGE = 3;

describe.each([
  ['light', light],
  ['dark', dark],
])('the %s theme', (_name, theme) => {
  const token = (name: string): string => {
    const value = theme[name];
    if (value === undefined) throw new Error(`the theme has no --${name}`);
    return value;
  };

  it.each([
    ['ink', 'bg'],
    ['ink', 'surface'],
    ['ink', 'surface-2'],
    ['ink-muted', 'bg'],
    ['ink-muted', 'surface'],
    ['ink-muted', 'surface-2'],
    ['ink-muted', 'warning-bg'],
    ['ink', 'warning-bg'],
    ['accent', 'bg'],
    ['accent', 'surface'],
    ['accent', 'surface-2'],
    ['accent-ink', 'accent'],
    ['danger', 'bg'],
    ['danger', 'surface'],
    ['danger', 'surface-2'],
  ])('reads %s on %s', (foreground, background) => {
    expect(contrast(token(foreground), token(background))).toBeGreaterThanOrEqual(TEXT);
  });

  it.each(['surface', 'surface-2'])('reads an accent badge on %s', (background) => {
    const tint = over(token('accent'), token(background), 0.1);
    expect(contrast(token('accent'), tint)).toBeGreaterThanOrEqual(TEXT);
  });

  it.each(['bg', 'surface', 'surface-2'])('shows the edge of a field on %s', (background) => {
    expect(contrast(token('border-control'), token(background))).toBeGreaterThanOrEqual(
      CONTROL_EDGE,
    );
  });

  it('paints the focus ring in a color that is seen on every surface', () => {
    for (const background of ['bg', 'surface', 'surface-2']) {
      expect(contrast(token('accent'), token(background))).toBeGreaterThanOrEqual(CONTROL_EDGE);
    }
  });
});

describe('the stylesheet', () => {
  it('colors what the person wrote in markdown with the theme, not the browser', () => {
    expect(css).toMatch(/\.markdown a\s*{[^}]*color:\s*var\(--accent\)/);
  });

  it('draws the edge of every field with the control border', () => {
    expect(css).toMatch(/\.input\s*{[^}]*border:\s*1px solid var\(--border-control\)/);
  });
});
