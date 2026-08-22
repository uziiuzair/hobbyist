// A real Node runtime with a real dependency tree, doing nothing clever at
// boot. This is the "lightweight app that doesn't do much while booting" case,
// measured rather than assumed.
const express = require('express')
const app = express()
app.get('/', (_req, res) => res.send('ok'))
app.listen(process.env.PORT || 8080, '0.0.0.0')
