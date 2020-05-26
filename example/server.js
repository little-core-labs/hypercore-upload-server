const { Server } = require('../')
const touch = require('touch')
const mkdirp = require('mkdirp-classic')
const path = require('path')
const raf = require('random-access-file')
const fs = require('fs')

const data = path.resolve(__dirname, 'data')
mkdirp.sync(data)

let size = 0
const server = new Server({
  storage(filename) {
    return raf(path.resolve(data, filename))
  },

  onwrite(key, offset, buffer, metadata, callback) {
    const filename = path.resolve(data, metadata.name)
    touch(filename, (err) => {
      if (err) { return callback(err) }
      fs.open(filename, fs.constants.O_RDWR | fs.constants.O_CREAT, (err, fd) => {
        if (err) { return callback(err) }
        fs.write(fd, buffer, 0, buffer.length, offset, (err) => {
          if (err) { return callback(err) }
          fs.close(fd, callback)
        })
      })
    })
  }
})

server.listen(3000, 'localhost', (err) => {
  const { address, port } = server.address()
  console.log('listening on %s:%s', address, port)
})
