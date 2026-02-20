export const theme = {
  colors: {
    bg: {
      primary: 'var(--bg-primary)',
      secondary: 'var(--bg-secondary)',
      tertiary: 'var(--bg-tertiary)',
    },
    accent: {
      blue: 'var(--accent-blue)',
      green: 'var(--accent-green)',
      red: 'var(--accent-red)',
      purple: 'var(--accent-purple)',
      orange: 'var(--accent-orange)',
    },
    text: {
      primary: 'var(--text-primary)',
      secondary: 'var(--text-secondary)',
      muted: 'var(--text-muted)',
    },
    border: {
      subtle: 'var(--border-subtle)',
    },
    glow: {
      ai: 'var(--glow-ai)',
    },
  },
} as const;

export type Theme = typeof theme;
