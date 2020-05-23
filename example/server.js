const { Server } = require('../')
const mkdirp = require('mkdirp-classic')
const path = require('path')
const raf = require('random-access-file')

const data = path.resolve(__dirname, 'data')
mkdirp.sync(data)

let size = 0
const server = new Server({
  storage(filename) {
    return raf(path.resolve(data, filename))
  },

  onwrite(key, offset, length, feed, metadata, done) {
    const filename = path.resolve(data, key.toString('hex'))
    const file = raf(filename)
    feed.getBatch(0, feed.length, (err, buffers) => {
      if (err) { return done(err) }
      const buffer = Buffer.concat(buffers)
      file.write(offset, buffer, done)
      size += buffer.length
    })
  }
})

server.listen(3000, 'localhost', (err) => {
  const { address, port } = server.address()
  console.log('listening on %s:%s', address, port)
})
