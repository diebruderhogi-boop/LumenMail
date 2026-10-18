// These are public OAuth application IDs, not secrets. Register LumenMail as a
// desktop/public client and put its IDs in these constants before packaging.
// Environment variables are only convenient for local development; they are
// not copied into a packaged installer automatically. Empty IDs keep sign-in
// disabled for that provider.
const publicClientIds = {
  google: '',
  microsoft: ''
};

module.exports = {
  googleClientId: process.env.LUMENMAIL_GOOGLE_CLIENT_ID || publicClientIds.google,
  microsoftClientId: process.env.LUMENMAIL_MICROSOFT_CLIENT_ID || publicClientIds.microsoft
};

