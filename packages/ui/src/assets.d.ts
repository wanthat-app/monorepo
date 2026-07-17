// Static-asset modules (the consuming app's bundler — Vite — turns these into URLs).
declare module "*.png" {
  const url: string;
  export default url;
}
declare module "*.jpg" {
  const url: string;
  export default url;
}
