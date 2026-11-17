// Logs one line per message. The runner looks for the marker it sent in
// `hobby logs`, which only this handler can have written.
export default {
  async fetch() {
    return new Response('consumer ok\n')
  },
  async queue(batch) {
    for (const message of batch.messages) {
      console.log(`smoke-consumer received ${message.body && message.body.id}`)
      message.ack()
    }
  },
}
