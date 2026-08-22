// standalone is what a real deployment uses: it emits a server.js with only
// the dependencies actually reached, which is both the smallest image and the
// fastest boot Next.js offers. Measuring anything else would be measuring a
// misconfiguration rather than Next.js.
export default { output: 'standalone' }
