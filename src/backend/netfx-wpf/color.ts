/**
 * Parses a CSS hex color string into ARGB components (each 0–255).
 * Accepts: #RGB, #RRGGBB, #AARRGGBB (Electron uses AA-prefixed alpha).
 * Returns null if the string is not a recognised hex color.
 */
export function parseBackgroundColor(color: string): { a: number; r: number; g: number; b: number } | null {
  const hex3 = color.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (hex3) return {
    a: 255,
    r: parseInt(hex3[1] + hex3[1], 16),
    g: parseInt(hex3[2] + hex3[2], 16),
    b: parseInt(hex3[3] + hex3[3], 16),
  };
  const hex6 = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex6) return {
    a: 255,
    r: parseInt(hex6[1], 16),
    g: parseInt(hex6[2], 16),
    b: parseInt(hex6[3], 16),
  };
  // #AARRGGBB — Electron convention for transparent background colors
  const hex8 = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex8) return {
    a: parseInt(hex8[1], 16),
    r: parseInt(hex8[2], 16),
    g: parseInt(hex8[3], 16),
    b: parseInt(hex8[4], 16),
  };
  return null;
}
