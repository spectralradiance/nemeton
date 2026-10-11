import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

const background = '#11130e';

// Generates favicon, PWA, maskable and Apple touch icons from one SVG at build time.
export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    ...minimal2023Preset,
    // The SVG is already full-bleed with the artwork inside the maskable safe zone: no padding.
    transparent: { ...minimal2023Preset.transparent, padding: 0 },
    maskable: { ...minimal2023Preset.maskable, padding: 0, resizeOptions: { background } },
    apple: { ...minimal2023Preset.apple, padding: 0, resizeOptions: { background } },
  },
  images: ['public/icon.svg'],
});
