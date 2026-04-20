const authRoutes               = require('./routes/auth')
const metricsRoutes            = require('./routes/metrics')
const { refreshAccountTokens } = require('./routes/auth')

module.exports = {
  authRoutes,
  metricsRoutes,
  refreshAccountTokens,
}
