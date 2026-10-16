import type { Project, ProjectColor } from '../../../shared/types'

/** Mid tones, readable on both the light and the dark sidebar. */
export const COLOR_VALUES: Record<ProjectColor, string> = {
  red: '#e0524a',
  orange: '#e8873a',
  yellow: '#e2b41b',
  green: '#3fa866',
  teal: '#2fa3a0',
  blue: '#3d82e0',
  purple: '#8c62d9',
  pink: '#d95a9c'
}

/** The CSS color of a project's color: a preset's value, or the custom color itself. */
export function colorValue(color: NonNullable<Project['color']>): string {
  return color.startsWith('#') ? color : COLOR_VALUES[color as ProjectColor]
}
