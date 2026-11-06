/**
 * Only for rendering a screen to markup in tests. `react-dom` is already a
 * dependency of the web build; this avoids adding `@types/react-dom` for one call.
 */
declare module 'react-dom/server' {
  import type { ReactNode } from 'react';

  export function renderToStaticMarkup(element: ReactNode): string;
}
