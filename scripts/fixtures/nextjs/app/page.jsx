// force-dynamic on purpose. A statically prerendered page is served from disk
// without the React server runtime doing any work, which would measure the
// filesystem rather than Next.js answering a request.
export const dynamic = 'force-dynamic'

export default function Page() {
  return <main>ok {new Date().toISOString()}</main>
}
