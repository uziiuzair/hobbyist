// hobby.sh
//
//   GET /install   the bootstrap script, as text/x-shellscript
//   everything else 301 to hobbyist.sh
//
// There is deliberately no landing page here. One site, at hobbyist.sh, and a
// second one to keep in sync is a second one to let rot.

// Bundled from scripts/web-install.sh at deploy time, via the Text rule in
// wrangler.toml. That file is the artifact, named in ADR 0006. Importing it
// rather than inlining a copy is what guarantees that the script a curl gets
// and the script in the repository are the same bytes.
import bootstrap from '../../scripts/web-install.sh'

const SITE = 'https://hobbyist.sh'

// Short enough that a fix to the installer reaches people the same day, long
// enough that the file is not re-fetched from origin on every install in a CI
// matrix. `must-revalidate` because a stale installer is a class of bug that
// is very hard for the person hitting it to diagnose.
const CACHE_CONTROL = 'public, max-age=300, must-revalidate'

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/install' || url.pathname === '/install.sh') {
      // HEAD is answered because some corporate proxies and download managers
      // probe with it before fetching, and a 405 there reads to the user as
      // "the install URL is broken".
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('method not allowed\n', {
          status: 405,
          headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' },
        })
      }

      return new Response(request.method === 'HEAD' ? null : bootstrap, {
        headers: {
          // charset matters: the script contains non-ASCII in none of its
          // paths today, and declaring it costs nothing and removes a whole
          // category of future surprise.
          'content-type': 'text/x-shellscript; charset=utf-8',
          'cache-control': CACHE_CONTROL,
          // A curl into bash is exactly the case where a reader might want to
          // read first. Telling them where costs one header.
          'x-source': 'https://github.com/uziiuzair/hobbyist/blob/main/scripts/web-install.sh',
          'x-content-type-options': 'nosniff',
        },
      })
    }

    // 301 rather than 302: this is permanent, and a permanent redirect is
    // cached by clients, which is the point.
    return Response.redirect(`${SITE}${url.pathname}${url.search}`, 301)
  },
}
