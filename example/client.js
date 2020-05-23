const { SingleBar } = require('cli-progress')
const multipart = require('hypercore-multipart')
const Corestore = require('corestore')
const WebSocket = require('simple-websocket')
const Batch = require('batch')
const pump = require('pump')
const path = require('path')
const ram = require('random-access-memory')
const fs = require('fs')

const corestore = new Corestore(ram)
const filename = __filename
//const filename = '/home/werle/Downloads/Big_Buck_Bunny_1080_10s_30MB.mp4'

let masterKey = null
let fd = 0

corestore.ready(() => {
  const feed = corestore.default()

  feed.ready(() => {
    // hello to server with public key ->
    const contextConnection = connect(`/${feed.key.toString('hex')}`)

    const stream = corestore.replicate(true, { live: true })

    pump(contextConnection, stream, contextConnection)

    // <- receive master key from server
    stream.registerExtension('hus/key', { onmessage: onmasterkey })

    // send metadata to server ->
    const metadataExtension = stream.registerExtension('hus/metadata', { encoding: 'json' })

    function onmasterkey(message) {
      // master key for ingestion provided by server
      masterKey = message

      // prepare ingestion multiparts
      const ingestion = multipart({ read, stat, corestore, masterKey, pageSize: 5 * 1024 * 1024 }, (err, hypercores) => {
        // optional metadata to send with ingestion
        metadataExtension.send({
          size: ingestion.stats.size,
          parts: ingestion.pages,
        })

        const batch = new Batch()
        const progress = new SingleBar()
        let pending = 0
        let total = 0

        // queue up batch of partitions for upload
        for (let i = 0; i < hypercores.length; ++i) {
          const hypercore = hypercores[i]
          const page = i + 1

          total += hypercore.length
          pending = total

          hypercore.on('upload', () =>  {
            progress.update(total - (--pending))
          })

          batch.push((done) => {
            const connection = connect(`/${feed.key.toString('hex')}/${page}`)
            const stream = hypercore.replicate(true, { ack: true })
            stream.on('ack', (ack) => {
              hypercore.clear(ack.start, ack.length, () => {
              })
            })

            pump(connection, stream, connection, done)
          })
        }

        console.log('%s blocks pending for upload', pending)
        progress.start(total, 0)

        batch.end((err) => {
          if (err) { throw err }
          corestore.close(() => {
            progress.stop()
          })
        })
      })
    }
  })
})

function connect(pathspec) {
  return new WebSocket(`ws://localhost:3000${pathspec}`)
}

function stat(callback) {
  fs.stat(filename, callback)
}

function read(offset, length, callback) {
  if (fd) {
    const buffer = Buffer.alloc(length)
    fs.read(fd, buffer, 0, length, offset, (err, bytesReads) => {
      callback(err, buffer.slice(0, bytesReads))
    })
  } else {
    fs.open(filename, (err, res) => {
      if (err) { callback(err) }
      else {
        fd = res
        read(offset, length, callback)
      }
    })
  }
}
