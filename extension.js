/**
 * The extension and corestore namespace for this server.
 * @public
 * @type {String}
 */
const NAMESPACE = 'hus'

/**
 * The metadata extension for the hypercore protocol used by this server.
 * @public
 * @type {String}
 */
const METADATA_EXTENSION = `${NAMESPACE}/metadata`

/**
 * The signal extension for the hypercore protocol used by this server.
 * @public
 * @type {String}
 */
const SIGNAL_EXTENSION = `${NAMESPACE}/signal`

/**
 * The master key extension for the hypercore protocol used by this server.
 * @public
 * @type {String}
 */
const KEY_EXTENSION = `${NAMESPACE}/key`

/**
 * Module exports.
 */
module.exports = {
  METADATA_EXTENSION,
  SIGNAL_EXTENSION,
  KEY_EXTENSION,
  NAMESPACE
}
