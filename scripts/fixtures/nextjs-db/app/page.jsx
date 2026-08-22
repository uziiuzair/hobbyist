// The case the product is actually about: a page that cannot render without
// its database. With both asleep, one request wakes two containers in sequence
// and the page is not ready until the query returns.
//
// A fresh Client per request, not a pool: a pool built at module load would
// connect while the container was still starting and hide the cost this
// fixture exists to measure.
import { Client } from 'pg'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    const result = await client.query('select now() as at')
    return <main>ok {String(result.rows[0].at)}</main>
  } finally {
    await client.end()
  }
}
