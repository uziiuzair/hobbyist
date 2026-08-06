import net from 'node:net'
import { parseStartup } from './startup.ts'
import { Timeline } from './timeline.ts'
import { start, isRunning } from './runtime.ts'
import { waitReady, pgProbe } from './ready.ts'
import { sleep, type Fixture } from './fixture.ts'

export type ProxyOpts = {
  listenPort: number
  fixture: Fixture
  pollMs: number
  wakeTimeoutMs: number
  onTimeline: (t: Timeline) => void
}

export type ProxyHandle = { close: () => Promise<void> }

export async function startProxy(opts: ProxyOpts): Promise<ProxyHandle> {
  const server = net.createServer((client) => {
    handleConnection(client, opts).catch((err) => {
      sendFatal(client, String(err))
    })
  })

  await new Promise<void>((resolve) => server.listen(opts.listenPort, '127.0.0.1', resolve))
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function handleConnection(client: net.Socket, opts: ProxyOpts): Promise<void> {
  const t = new Timeline()
  t.mark('accept')

  const startup = await readStartup(client)
  t.mark('parsed')

  // Mark after start returns, not before. The segment is defined as "parsed to
  // the start command returning", so marking first would report roughly zero
  // and quietly fold the command's own cost into container_up.
  if (!(await isRunning(opts.fixture.name))) {
    await start(opts.fixture.name)
  }
  t.mark('wake_issued')

  const upDeadline = Date.now() + opts.wakeTimeoutMs
  while (!(await isRunning(opts.fixture.name))) {
    if (Date.now() > upDeadline) {
      sendFatal(client, 'container did not start')
      return
    }
    await sleep(5)
  }
  t.mark('container_up')

  const ready = await waitReady({
    probe: pgProbe(opts.fixture),
    pollMs: opts.pollMs,
    timeoutMs: opts.wakeTimeoutMs,
  })
  if (!ready.ready) {
    sendFatal(client, 'postgres did not become ready before the wake timeout')
    return
  }
  t.mark('pg_ready')

  const upstream = net.createConnection({ host: '127.0.0.1', port: opts.fixture.hostPort })
  await new Promise<void>((resolve, reject) => {
    upstream.once('connect', resolve)
    upstream.once('error', reject)
  })
  upstream.write(startup)
  t.mark('upstream_connected')
  opts.onTimeline(t)

  client.pipe(upstream)
  upstream.pipe(client)
  const teardown = () => {
    client.destroy()
    upstream.destroy()
  }
  client.on('error', teardown)
  upstream.on('error', teardown)
  client.on('close', teardown)
  upstream.on('close', teardown)
}

// Reads until a real startup packet arrives, declining SSL along the way. The
// spike does not terminate TLS, so it answers SSLRequest with 'N' and the
// client retries in plaintext. M2 terminates instead, because it must.
async function readStartup(client: net.Socket): Promise<Buffer> {
  let buf = Buffer.alloc(0)
  for (;;) {
    const chunk = await once(client)
    buf = Buffer.concat([buf, chunk])
    const parsed = parseStartup(buf)
    if (!parsed) continue
    if (parsed.message.type === 'ssl_request') {
      client.write(Buffer.from('N'))
      buf = buf.subarray(parsed.consumed)
      continue
    }
    if (parsed.message.type === 'cancel_request') {
      throw new Error('cancel request is out of scope for the spike')
    }
    return buf.subarray(0, parsed.consumed)
  }
}

function once(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    socket.once('data', resolve)
    socket.once('error', reject)
    socket.once('close', () => reject(new Error('client closed before sending a startup packet')))
  })
}

// A real Postgres ErrorResponse, so a client library shows a message instead of
// an unreadable socket error. The spec calls this out as the failure mode that
// makes people uninstall.
function sendFatal(client: net.Socket, message: string): void {
  const fields = [
    Buffer.from(`S${'FATAL'}\0`, 'utf8'),
    Buffer.from(`C${'57P03'}\0`, 'utf8'),
    Buffer.from(`M${message}\0`, 'utf8'),
    Buffer.from([0]),
  ]
  const body = Buffer.concat(fields)
  const out = Buffer.alloc(5 + body.length)
  out.write('E', 0, 'ascii')
  out.writeInt32BE(4 + body.length, 1)
  body.copy(out, 5)
  client.end(out)
}
