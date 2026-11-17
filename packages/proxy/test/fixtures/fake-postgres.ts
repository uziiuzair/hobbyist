// A fake Postgres backend for the serverless driver tests: enough of the
// real protocol for node-postgres and @neondatabase/serverless to log in
// and run queries through the proxy, with no Docker. It authenticates with
// SCRAM-SHA-256 as the stock image does (scram-sha-256 in pg_hba.conf, the
// default password_encryption), so a client that sends a cleartext password
// where a SASLInitialResponse belongs fails here as it would against the
// real server. Queries are answered by a handler the test supplies.

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import net from 'node:net'

export interface FakeField {
  name: string
  typeId: number
}

export interface FakeResult {
  fields: FakeField[]
  rows: Array<Array<string | null>>
  command: string
}

export class FakePgError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly extra: Record<string, string> = {}
  ) {
    super(message)
  }
}

export type QueryHandler = (sql: string, params: Array<string | null>) => FakeResult

export interface FakePostgres {
  port: number
  // Startup parameters of every session that reached the query phase.
  sessions: Array<Record<string, string>>
  // Every statement run, simple or extended, in order.
  queries: Array<{ sql: string; params: Array<string | null> }>
  cancels: number
  close(): Promise<void>
}

const hmac = (key: Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest()

function msg(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5)
  header.write(type, 0, 'latin1')
  header.writeInt32BE(body.length + 4, 1)
  return Buffer.concat([header, body])
}
const int32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeInt32BE(n, 0)
  return b
}
const int16 = (n: number): Buffer => {
  const b = Buffer.alloc(2)
  b.writeInt16BE(n, 0)
  return b
}
const cstr = (s: string): Buffer => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])])

function errorMessage(code: string, message: string, extra: Record<string, string> = {}): Buffer {
  const parts = [Buffer.from('SERROR\0VERROR\0', 'utf8'), Buffer.from(`C${code}\0M${message}\0`, 'utf8')]
  for (const [k, v] of Object.entries(extra)) parts.push(Buffer.from(`${k}${v}\0`, 'utf8'))
  parts.push(Buffer.from([0]))
  return msg('E', Buffer.concat(parts))
}

function rowDescription(fields: FakeField[]): Buffer {
  return msg(
    'T',
    Buffer.concat([
      int16(fields.length),
      ...fields.map((f) => Buffer.concat([cstr(f.name), int32(0), int16(0), int32(f.typeId), int16(-1), int32(-1), int16(0)])),
    ])
  )
}

function dataRow(row: Array<string | null>): Buffer {
  return msg(
    'D',
    Buffer.concat([
      int16(row.length),
      ...row.map((v) => (v === null ? int32(-1) : Buffer.concat([int32(Buffer.byteLength(v)), Buffer.from(v, 'utf8')]))),
    ])
  )
}

function commandTag(result: FakeResult): string {
  const c = result.command.toUpperCase()
  if (c === 'SELECT') return `SELECT ${result.rows.length}`
  if (c === 'INSERT') return `INSERT 0 ${result.rows.length}`
  return result.command
}

export function startFakePostgres(opts: { password: string; handler: QueryHandler }): Promise<FakePostgres> {
  const salt = randomBytes(16)
  const iterations = 4096
  const salted = pbkdf2Sync(opts.password, salt, iterations, 32, 'sha256')
  const storedKey = createHash('sha256').update(hmac(salted, 'Client Key')).digest()
  const serverKey = hmac(salted, 'Server Key')

  const state: FakePostgres = {
    port: 0,
    sessions: [],
    queries: [],
    cancels: 0,
    close: async () => {},
  }
  const sockets = new Set<net.Socket>()

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buffer = Buffer.alloc(0)
    let phase: 'startup' | 'sasl_initial' | 'sasl_final' | 'ready' = 'startup'
    let params: Record<string, string> = {}
    let clientFirstBare = ''
    let serverFirst = ''
    let inTransaction = false
    let skipUntilSync = false
    let portal: { result: FakeResult } | null = null
    let parsed = ''

    const ready = (): Buffer => msg('Z', Buffer.from(inTransaction ? 'T' : 'I'))
    const run = (sql: string, values: Array<string | null>): FakeResult => {
      state.queries.push({ sql, params: values })
      const upper = sql.trim().toUpperCase()
      if (upper.startsWith('BEGIN')) {
        inTransaction = true
        return { fields: [], rows: [], command: 'BEGIN' }
      }
      if (upper === 'COMMIT' || upper === 'ROLLBACK') {
        inTransaction = false
        return { fields: [], rows: [], command: upper }
      }
      return opts.handler(sql, values)
    }

    const handle = (type: string, body: Buffer): void => {
      if (phase === 'sasl_initial') {
        const mechEnd = body.indexOf(0)
        const mechanism = body.toString('utf8', 0, mechEnd)
        if (type !== 'p' || mechanism !== 'SCRAM-SHA-256') {
          socket.end(errorMessage('08P01', 'expected SASL response'))
          return
        }
        const first = body.toString('utf8', mechEnd + 5)
        clientFirstBare = first.replace(/^n,,/, '')
        const clientNonce = /r=([^,]+)/.exec(clientFirstBare)?.[1] ?? ''
        serverFirst = `r=${clientNonce}${randomBytes(12).toString('base64')},s=${salt.toString('base64')},i=${iterations}`
        socket.write(msg('R', Buffer.concat([int32(11), Buffer.from(serverFirst)])))
        phase = 'sasl_final'
        return
      }
      if (phase === 'sasl_final') {
        const final = body.toString('utf8')
        const withoutProof = final.replace(/,p=[^,]+$/, '')
        const proof = Buffer.from(/p=([^,]+)$/.exec(final)?.[1] ?? '', 'base64')
        const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`
        const signature = hmac(storedKey, authMessage)
        const clientKey = Buffer.alloc(32)
        for (let i = 0; i < 32; i++) clientKey[i] = (proof[i] ?? 0) ^ signature[i]!
        if (!createHash('sha256').update(clientKey).digest().equals(storedKey)) {
          socket.end(errorMessage('28P01', `password authentication failed for user "${params['user'] ?? ''}"`))
          return
        }
        state.sessions.push(params)
        socket.write(
          Buffer.concat([
            msg('R', Buffer.concat([int32(12), Buffer.from(`v=${hmac(serverKey, authMessage).toString('base64')}`)])),
            msg('R', int32(0)),
            msg('S', Buffer.concat([cstr('server_version'), cstr('18.0')])),
            msg('S', Buffer.concat([cstr('client_encoding'), cstr('UTF8')])),
            msg('S', Buffer.concat([cstr('standard_conforming_strings'), cstr('on')])),
            msg('S', Buffer.concat([cstr('integer_datetimes'), cstr('on')])),
            msg('S', Buffer.concat([cstr('DateStyle'), cstr('ISO, MDY')])),
            msg('K', Buffer.concat([int32(4242), int32(98765)])),
            ready(),
          ])
        )
        phase = 'ready'
        return
      }
      // Query phase.
      if (type === 'X') {
        socket.end()
        return
      }
      if (type === 'S') {
        skipUntilSync = false
        socket.write(ready())
        return
      }
      if (skipUntilSync) return
      try {
        switch (type) {
          case 'Q': {
            const sql = body.toString('utf8', 0, body.length - 1)
            const result = run(sql, [])
            const out: Buffer[] = []
            if (result.fields.length > 0) out.push(rowDescription(result.fields))
            for (const row of result.rows) out.push(dataRow(row))
            out.push(msg('C', cstr(commandTag(result))), ready())
            socket.write(Buffer.concat(out))
            return
          }
          case 'P': {
            const nameEnd = body.indexOf(0)
            const queryEnd = body.indexOf(0, nameEnd + 1)
            parsed = body.toString('utf8', nameEnd + 1, queryEnd)
            socket.write(msg('1', Buffer.alloc(0)))
            return
          }
          case 'B': {
            let off = body.indexOf(0) + 1
            off = body.indexOf(0, off) + 1
            const nFormats = body.readInt16BE(off)
            off += 2 + nFormats * 2
            const nParams = body.readInt16BE(off)
            off += 2
            const values: Array<string | null> = []
            for (let i = 0; i < nParams; i++) {
              const len = body.readInt32BE(off)
              off += 4
              if (len === -1) values.push(null)
              else {
                values.push(body.toString('utf8', off, off + len))
                off += len
              }
            }
            portal = { result: run(parsed, values) }
            socket.write(msg('2', Buffer.alloc(0)))
            return
          }
          case 'D': {
            const fields = portal?.result.fields ?? []
            socket.write(fields.length > 0 ? rowDescription(fields) : msg('n', Buffer.alloc(0)))
            return
          }
          case 'E': {
            const result = portal?.result ?? { fields: [], rows: [], command: 'SELECT' }
            socket.write(Buffer.concat([...result.rows.map(dataRow), msg('C', cstr(commandTag(result)))]))
            return
          }
          case 'H':
            return
          case 'C':
            socket.write(msg('3', Buffer.alloc(0)))
            return
          default:
            socket.write(errorMessage('08P01', `unexpected message ${type}`))
        }
      } catch (err) {
        if (err instanceof FakePgError) {
          skipUntilSync = type !== 'Q'
          socket.write(Buffer.concat([errorMessage(err.code, err.message, err.extra), ...(type === 'Q' ? [ready()] : [])]))
          return
        }
        throw err
      }
    }

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (phase === 'startup') {
          if (buffer.length < 8) return
          const len = buffer.readInt32BE(0)
          if (buffer.length < len) return
          const code = buffer.readInt32BE(4)
          if (code === 80877102) {
            state.cancels++
            socket.end()
            return
          }
          const fields = buffer.toString('utf8', 8, len - 1).split('\0')
          params = {}
          for (let i = 0; i + 1 < fields.length; i += 2) params[fields[i]!] = fields[i + 1]!
          buffer = buffer.subarray(len)
          socket.write(msg('R', Buffer.concat([int32(10), cstr('SCRAM-SHA-256'), Buffer.from([0])])))
          phase = 'sasl_initial'
          continue
        }
        if (buffer.length < 5) return
        const len = buffer.readInt32BE(1)
        if (buffer.length < 1 + len) return
        const type = String.fromCharCode(buffer[0]!)
        const body = buffer.subarray(5, 1 + len)
        buffer = buffer.subarray(1 + len)
        handle(type, body)
        if (socket.destroyed || !socket.writable) return
      }
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      state.port = typeof address === 'object' && address !== null ? address.port : 0
      state.close = () =>
        new Promise((res) => {
          for (const s of sockets) s.destroy()
          server.close(() => res())
        })
      resolve(state)
    })
  })
}
