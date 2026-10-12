import localFont from "next/font/local";

const inter = localFont({
  src: "./fonts/inter-latin-wght-normal.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-inter",
  preload: false,
});

const notoSans = localFont({
  src: "./fonts/catalogue/noto-sans.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-noto-sans",
  preload: false,
});

const nunitoSans = localFont({
  src: "./fonts/catalogue/nunito-sans.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-nunito-sans",
  preload: false,
});

const figtree = localFont({
  src: "./fonts/catalogue/figtree.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-figtree",
  preload: false,
});

const roboto = localFont({
  src: "./fonts/catalogue/roboto.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-roboto",
  preload: false,
});

const raleway = localFont({
  src: "./fonts/catalogue/raleway.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-raleway",
  preload: false,
});

const dmSans = localFont({
  src: "./fonts/catalogue/dm-sans.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-dm-sans",
  preload: false,
});

const publicSans = localFont({
  src: "./fonts/catalogue/public-sans.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-public-sans",
  preload: false,
});

const outfit = localFont({
  src: "./fonts/catalogue/outfit.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-outfit",
  preload: false,
});

const jetbrainsMono = localFont({
  src: "./fonts/catalogue/jetbrains-mono.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-jetbrains-mono",
  preload: false,
});

const geist = localFont({
  src: "./fonts/catalogue/geist.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-geist",
  preload: false,
});

const geistMono = localFont({
  src: "./fonts/catalogue/geist-mono.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-geist-mono",
  preload: false,
});

const lora = localFont({
  src: "./fonts/catalogue/lora.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-lora",
  preload: false,
});

const merriweather = localFont({
  src: "./fonts/catalogue/merriweather.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-merriweather",
  preload: false,
});

const playfairDisplay = localFont({
  src: "./fonts/catalogue/playfair-display.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-playfair-display",
  preload: false,
});

const notoSerif = localFont({
  src: "./fonts/catalogue/noto-serif.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-noto-serif",
  preload: false,
});

const robotoSlab = localFont({
  src: "./fonts/catalogue/roboto-slab.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-roboto-slab",
  preload: false,
});

const oxanium = localFont({
  src: "./fonts/catalogue/oxanium.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-oxanium",
  preload: false,
});

const manrope = localFont({
  src: "./fonts/catalogue/manrope.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-manrope",
  preload: false,
});

const spaceGrotesk = localFont({
  src: "./fonts/catalogue/space-grotesk.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-space-grotesk",
  preload: false,
});

const montserrat = localFont({
  src: "./fonts/catalogue/montserrat.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-montserrat",
  preload: false,
});

const ibmPlexSans = localFont({
  src: "./fonts/catalogue/ibm-plex-sans.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-ibm-plex-sans",
  preload: false,
});

const sourceSans3 = localFont({
  src: "./fonts/catalogue/source-sans-3.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-source-sans-3",
  preload: false,
});

const instrumentSans = localFont({
  src: "./fonts/catalogue/instrument-sans.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-instrument-sans",
  preload: false,
});

const ebGaramond = localFont({
  src: "./fonts/catalogue/eb-garamond.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-eb-garamond",
  preload: false,
});

const instrumentSerif = localFont({
  src: "./fonts/catalogue/instrument-serif.woff2",
  display: "swap",
  weight: "400",
  variable: "--vortex-font-instrument-serif",
  preload: false,
});

/** Classes expose each self-hosted catalogue font variable; faces load only when selected text uses them. */
export const SHADCN_FONT_VARIABLE_CLASSES = [
  inter.variable,
  notoSans.variable,
  nunitoSans.variable,
  figtree.variable,
  roboto.variable,
  raleway.variable,
  dmSans.variable,
  publicSans.variable,
  outfit.variable,
  jetbrainsMono.variable,
  geist.variable,
  geistMono.variable,
  lora.variable,
  merriweather.variable,
  playfairDisplay.variable,
  notoSerif.variable,
  robotoSlab.variable,
  oxanium.variable,
  manrope.variable,
  spaceGrotesk.variable,
  montserrat.variable,
  ibmPlexSans.variable,
  sourceSans3.variable,
  instrumentSans.variable,
  ebGaramond.variable,
  instrumentSerif.variable,
] as const;
