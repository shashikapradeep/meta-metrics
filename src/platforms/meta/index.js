const authRoutes              = require('./routes/auth')
const metricsRoutes           = require('./routes/metrics')
const connectionRoutes = require('./routes/connections')
const { refreshAccountTokens } = require('./routes/auth')

module.exports = {
  authRoutes,
  metricsRoutes,
  connectionRoutes,
  refreshAccountTokens,
}
