// Design tokens extracted from Codeman's styles.css and index.html

export const colors = {
  bg: {
    dark: '#0a0a0a',
    card: '#141414',
    input: '#1a1a1a',
    hover: '#222',
    terminal: '#0d0d0d',
  },
  border: {
    default: '#2a2a2a',
    light: '#333',
  },
  text: {
    primary: '#eee',
    dim: '#888',
    muted: '#555',
  },
  accent: {
    blue: '#3b82f6',
    blueHover: '#60a5fa',
    green: '#22c55e',
    yellow: '#eab308',
    red: '#ef4444',
    purple: '#a855f7',
    orange: '#f97316',
  },
} as const;

export const layout = {
  headerHeight: 36,
  toolbarHeight: 40,
  tabHeight: 28,
  borderRadius: 4,
} as const;

export const fonts = {
  ui: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  mono: "'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', Menlo, monospace",
} as const;

