/**
 * Asset versioning utility for cache busting
 * Generates version strings based on package version and build time/git commit
 */

const packageJson = require('../package.json');
const crypto = require('crypto');
const logger = require('./logger');

// Use RENDER_GIT_COMMIT (Render's built-in env var) for reliable cache busting
// Falls back to BUILD_TIME or Date.now() for local development
const buildIdentifier = process.env.RENDER_GIT_COMMIT || process.env.BUILD_TIME || Date.now().toString();

// Generate a hash from package version for cache busting
const ASSET_VERSION = crypto
  .createHash('md5')
  .update(packageJson.version + buildIdentifier)
  .digest('hex')
  .substring(0, 8);

// Log asset version on startup for debugging cache issues
logger.info({ assetVersion: ASSET_VERSION, buildIdentifier }, 'Asset version initialized');

/**
 * Adds a version query string to an asset path for cache busting
 * @param {string} assetPath - The path to the asset (e.g., '/css/output.css')
 * @returns {string} - The asset path with version query string (e.g., '/css/output.css?v=abc12345')
 */
function versionedAsset(assetPath) {
  return `${assetPath}?v=${ASSET_VERSION}`;
}

module.exports = { ASSET_VERSION, versionedAsset };

