const rimraf = require('rimraf')
const debug = require('debug')('hypercore-upload-server')
const Batch = require('batch')

/**
 * A worker task to remove files from the file system.
 * @param {Object} opts
 * @return {Promise}
 */
function task(opts) {
  const { queue } = opts
  return new Promise((resolve, reject) => {
    const batch = new Batch()

    for (const item of queue) {
      if (item && 'string' === typeof item && '/' !== item) {
        debug('Will remove %s', item)
        batch.push((next) => rimraf(item, next))
      }
    }

    batch.end((err) => {
      if (err) { reject(err) }
      else { resolve() }
    })
  })
}

module.exports = task
