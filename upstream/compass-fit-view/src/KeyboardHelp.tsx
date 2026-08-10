/**
 * KeyboardHelp shortcuts list — upstream port.
 *
 * The shipped component renders an array of `{ keys: string[], label: string }`
 * entries. This is the patched list: one new entry (`F` → Fit view) appended
 * after the existing zoom/reset entries. Keep the surrounding component markup
 * as-is in the real repo; this file only pins the array contents.
 */

export interface ShortcutEntry {
  keys: string[];
  label: string;
}

export const SHORTCUTS: ShortcutEntry[] = [
  { keys: ['⌘', 'K'], label: 'Open command palette' },
  { keys: ['Esc'], label: 'Reset mode / close panel' },
  { keys: ['?'], label: 'Toggle keyboard shortcuts' },
  { keys: ['L'], label: 'Quick locate (selected node)' },
  { keys: ['I'], label: 'Quick impact (selected node)' },
  { keys: ['+'], label: 'Zoom in' },
  { keys: ['-'], label: 'Zoom out' },
  { keys: ['0'], label: 'Reset zoom & center' },
  // NEW: fit the whole node graph into the viewport.
  { keys: ['F'], label: 'Fit view (fit whole graph)' },
];
