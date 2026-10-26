/** A stylesheet imported with `?raw` is its source text (the Turbopack rule in next.config.ts). */
declare module "*.css?raw" {
  const source: string;
  export default source;
}
