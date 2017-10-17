const { usePlugin } = require('@nomiclabs/buidler/config')
const hooks = require('./scripts/buidler-hooks')

const baseConfig = require('../../buidler.config.js')

usePlugin('@aragon/buidler-aragon')

module.exports = {
  ...baseConfig,
  paths: {
    ...baseConfig.paths,
    root: '../..'
  },
  defaultNetwork: 'localhost',
  // Aragon plugin configuration
  aragon: {
    appServePort: 3012,
    clientServePort: 3000,
    appSrcPath: 'app/',
    appBuildOutputPath: 'dist/',
    appName: 'steth',
    hooks // Path to script hooks
  }
}
