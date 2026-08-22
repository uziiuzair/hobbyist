// Dynamic on purpose. A statically prerendered page would be served from disk
// without the React server runtime ever doing work, which would measure the
// file system rather than Next.js booting.
export const dynamic = 'force-dynamic'

export default function Page() {
  return <main>ok {new Date().toISOString()}</main>
}
