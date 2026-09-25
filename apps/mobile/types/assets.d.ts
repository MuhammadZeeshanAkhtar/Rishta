/**
 * Image imports.
 *
 * Metro resolves `import logo from './logo.png'` to an asset reference at
 * bundle time; TypeScript needs telling what that is. Declaring it here keeps
 * asset imports as ordinary ESM rather than `require()` calls with a lint
 * exemption.
 */
declare module '*.png' {
  import type { ImageSourcePropType } from 'react-native';

  const content: ImageSourcePropType;
  export default content;
}
