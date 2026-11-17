// GET /send?id=<marker> enqueues {id} and answers "sent <id>". A failed send
// answers 500 with the error, so the runner can print why.
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const id = url.searchParams.get('id')
    if (url.pathname !== '/send' || !id) return new Response('producer ok\n')
    try {
      await env.JOBS.send({ id })
      return new Response(`sent ${id}\n`)
    } catch (err) {
      return new Response(`send failed: ${err && err.message ? err.message : String(err)}\n`, { status: 500 })
    }
  },
}
