/** Single dark palette. This is a one-user utility app — no light theme. */
export const colors = {
  background: '#0b0f14',
  surface: '#141a22',
  surfaceRaised: '#1c2430',
  border: '#2a3441',
  textPrimary: '#f2f5f8',
  textSecondary: '#9aa7b5',
  textMuted: '#6b7684',
  accent: '#4da3ff',
  good: '#3ecf8e',
  bad: '#ff5c5c',
  warning: '#f5a623',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;
