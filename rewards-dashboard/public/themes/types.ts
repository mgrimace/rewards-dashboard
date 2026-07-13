export type ThemeMode = "light" | "dark";

export interface ThemePalette {
  // Surfaces
  canvas: string; // page background (was 'bg' in todo)
  surface: string; // elevated surfaces, cards
  surfaceAlt: string; // secondary surface, form fields
  hover: string; // interactive hover surface

  // Text
  text: string;
  textMuted: string;
  textInverse: string; // text on accent-coloured backgrounds

  // Borders
  border: string;
  borderStrong: string;

  // Accent / Interactive
  accent: string;
  accentHover: string; // darker accent for hover/active states (was 'accentStrong' in todo)
  accentSubtle: string; // soft tinted background for selected/active states
  focus: string; // focus ring colour

  // Semantic
  positive: string; // income, success
  negative: string; // expense, danger (was 'danger' in todo)

  // Energy levels — todo-specific, silently ignored by budget themeManager
  energyLowBg: string;
  energyLowAccent: string;
  energyLowText: string;
  energyMediumBg: string;
  energyMediumAccent: string;
  energyMediumText: string;
  energyHighBg: string;
  energyHighAccent: string;
  energyHighText: string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  palettes: {
    light: ThemePalette;
    dark: ThemePalette;
  };
}
