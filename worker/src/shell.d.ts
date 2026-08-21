// wrangler's Text rule turns a .sh import into a string at build time. Without
// this, tsc has no idea what `import bootstrap from '../../scripts/web-install.sh'` is.
declare module '*.sh' {
  const contents: string
  export default contents
}
