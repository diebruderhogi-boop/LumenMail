const http = require('node:http');
const crypto = require('node:crypto');
const { shell } = require('electron');

const AUTH_ROOT = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const REQUIRED_SCOPE = 'chatgpt.tokens.use.direct';

function randomBase64Url(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }

async function tokenRequest(parameters) {
  const response = await fetch(`${AUTH_ROOT}/api/accounts/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(parameters),
    signal: AbortSignal.timeout(30000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error_description || result.error || `Anmeldung bei ChatGPT fehlgeschlagen (HTTP ${response.status}).`);
    error.code = result.error || '';
    throw error;
  }
  return result;
}

async function verifyIdToken(idToken, clientId, expectedNonce) {
  const pieces = String(idToken || '').split('.');
  if (pieces.length !== 3) throw new Error('ChatGPT hat ein ungültiges Identitätstoken zurückgegeben.');
  const header = JSON.parse(Buffer.from(pieces[0], 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(pieces[1], 'base64url').toString('utf8'));
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Das Identitätstoken verwendet einen nicht unterstützten Signaturalgorithmus.');
  const discovery = await fetch(`${AUTH_ROOT}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15000) });
  if (!discovery.ok) throw new Error('Die ChatGPT-Anmeldedaten konnten nicht geprüft werden.');
  const metadata = await discovery.json();
  const keyResponse = await fetch(metadata.jwks_uri, { signal: AbortSignal.timeout(15000) });
  if (!keyResponse.ok) throw new Error('Der Signaturschlüssel der ChatGPT-Anmeldung konnte nicht abgerufen werden.');
  const keySet = await keyResponse.json();
  const jwk = (keySet.keys || []).find((key) => key.kid === header.kid && key.kty === 'RSA');
  if (!jwk) throw new Error('Der Signaturschlüssel für die ChatGPT-Anmeldung wurde nicht gefunden.');
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const validSignature = crypto.verify('RSA-SHA256', Buffer.from(`${pieces[0]}.${pieces[1]}`), publicKey, Buffer.from(pieces[2], 'base64url'));
  if (!validSignature) throw new Error('Die Signatur der ChatGPT-Anmeldung ist ungültig.');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== 'https://auth.openai.com' || !audience.includes(clientId)) throw new Error('Die Identität des ChatGPT-Kontos konnte nicht bestätigt werden.');
  if (!claims.exp || Number(claims.exp) <= Date.now() / 1000 - 30) throw new Error('Die ChatGPT-Anmeldung ist abgelaufen.');
  if (claims.nonce !== expectedNonce || !claims.sub) throw new Error('Die Sicherheitsprüfung der ChatGPT-Anmeldung ist fehlgeschlagen.');
  return claims;
}

async function signIn({ hostId, existingProfile = null, pendingProfile = null, onRegistration = async () => {} }) {
  const state = randomBase64Url();
  const nonce = randomBase64Url();
  const verifier = randomBase64Url(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const savedRegistration = existingProfile || (pendingProfile?.hostId === hostId ? pendingProfile : null);
  const clientId = savedRegistration?.clientId || 'dynamic_agent_client';
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const callbackResult = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Die ChatGPT-Anmeldung ist abgelaufen. Bitte erneut versuchen.')), 5 * 60 * 1000);
    server.on('request', (request, response) => {
      const callbackUrl = new URL(request.url, redirectUri);
      if (callbackUrl.pathname !== '/auth/callback') {
        response.writeHead(404).end('Not found');
        return;
      }
      if (callbackUrl.searchParams.get('state') !== state) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('LumenMail konnte die Anmeldung nicht bestätigen. Bitte schließe dieses Fenster.');
        clearTimeout(timeout);
        reject(new Error('Die Sicherheitsprüfung der ChatGPT-Anmeldung ist fehlgeschlagen.'));
        return;
      }
      if (callbackUrl.searchParams.get('error')) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><title>LumenMail</title><p>Die ChatGPT-Anmeldung wurde nicht abgeschlossen. Dieses Fenster kann geschlossen werden.</p>');
        clearTimeout(timeout);
        reject(new Error(callbackUrl.searchParams.get('error_description') || 'Die ChatGPT-Anmeldung wurde abgebrochen.'));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end('<!doctype html><meta charset="utf-8"><title>LumenMail</title><p>ChatGPT ist mit LumenMail verbunden. Dieses Fenster kann geschlossen werden.</p>');
      clearTimeout(timeout);
      resolve({ code: callbackUrl.searchParams.get('code'), callbackClientId: callbackUrl.searchParams.get('client_id'), scope: callbackUrl.searchParams.get('scope') || '' });
    });
  });
  // The browser opener can fail before the callback is awaited; mark this promise handled meanwhile.
  callbackResult.catch(() => {});
  const authorize = new URL(`${AUTH_ROOT}/api/accounts/authorize`);
  authorize.search = new URLSearchParams({
    client_id: clientId,
    ...(savedRegistration ? {} : { agent_name_hint: 'LumenMail' }),
    ext_agent_host_id: hostId,
    ...(existingProfile?.idToken ? { id_token_hint: existingProfile.idToken } : {}),
    ...(existingProfile?.email ? { login_hint: existingProfile.email } : {}),
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge
  }).toString();
  try {
    await shell.openExternal(authorize.toString());
    const callback = await callbackResult;
    if (!callback.code) throw new Error('Die ChatGPT-Anmeldung hat keinen Autorisierungscode zurückgegeben.');
    const issuedClientId = callback.callbackClientId || savedRegistration?.clientId || '';
    if (!issuedClientId || (savedRegistration && issuedClientId !== savedRegistration.clientId) || (!savedRegistration && issuedClientId === 'dynamic_agent_client')) {
      throw new Error('Die ChatGPT-Registrierung konnte nicht sicher zugeordnet werden. Bitte erneut anmelden.');
    }
    // A dynamic client ID must survive even if the one-time code expires or is rejected.
    // OpenAI requires a fresh authorization attempt to reuse this issued ID.
    if (!savedRegistration) await onRegistration({ clientId: issuedClientId, hostId, savedAt: Date.now() });
    let tokens;
    try {
      tokens = await tokenRequest({
        grant_type: 'authorization_code',
        client_id: issuedClientId,
        code: callback.code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: RESOURCE
      });
    } catch (error) {
      if (error.code === 'invalid_grant') {
        throw new Error('ChatGPT hat den einmaligen Anmeldecode abgelehnt oder er ist abgelaufen. Die Kontoregistrierung wurde gesichert. Klicke erneut auf „ChatGPT verbinden“, damit LumenMail eine frische Anmeldung startet.');
      }
      throw error;
    }
    const claims = await verifyIdToken(tokens.id_token, issuedClientId, nonce);
    if (existingProfile?.subject && claims.sub !== existingProfile.subject) {
      throw new Error('Das angemeldete ChatGPT-Konto stimmt nicht mit dem gespeicherten Konto überein. Bitte verbinde es als neues Konto.');
    }
    const granted = new Set(String(tokens.scope || '').split(/[\s,]+/).filter(Boolean));
    if (!granted.size) throw new Error('ChatGPT hat die freigegebenen Berechtigungen nicht bestätigt. Bitte verbinde dein Konto erneut.');
    if (!granted.has(REQUIRED_SCOPE)) throw new Error('ChatGPT wurde verbunden, aber die Nutzung des ChatGPT-Plans wurde nicht freigegeben. Bitte verbinde ChatGPT erneut und erlaube die angezeigte Nutzung.');
    const savedAt = Date.now();
    return {
      clientId: issuedClientId,
      hostId,
      email: String(claims.email || ''),
      subject: String(claims.sub),
      idToken: tokens.id_token,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenType: tokens.token_type || 'Bearer',
      scopes: [...granted],
      expiresAt: savedAt + Number(tokens.expires_in || 3600) * 1000,
      savedAt
    };
  } finally {
    server.close();
  }
}

async function refreshProfile(profile) {
  if (!profile?.refreshToken) throw new Error('Die ChatGPT-Verbindung ist abgelaufen. Bitte verbinde dein Konto erneut.');
  const tokens = await tokenRequest({
    grant_type: 'refresh_token',
    client_id: profile.clientId,
    refresh_token: profile.refreshToken,
    resource: RESOURCE
  });
  return {
    ...profile,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || profile.refreshToken,
    tokenType: tokens.token_type || profile.tokenType || 'Bearer',
    scopes: tokens.scope ? String(tokens.scope).split(/[\s,]+/).filter(Boolean) : profile.scopes,
    expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
    savedAt: Date.now()
  };
}

async function getModels(accessToken) {
  const response = await fetch(`${RESOURCE}/models`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) return [];
  const result = await response.json().catch(() => ({}));
  return (result.models || []).filter((item) => item.visibility === 'list' && item.slug)
    .map((item) => ({ slug: String(item.slug), displayName: String(item.display_name || item.slug) }));
}

async function revokeProfile(profile) {
  if (!profile?.refreshToken) return { revoked: true };
  const discovery = await fetch(`${AUTH_ROOT}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15000) });
  const metadata = await discovery.json();
  if (!metadata.revocation_endpoint) throw new Error('Der ChatGPT-Abmeldedienst ist momentan nicht erreichbar.');
  const response = await fetch(metadata.revocation_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: profile.refreshToken, token_type_hint: 'refresh_token', client_id: profile.clientId }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error('Die ChatGPT-Sitzung konnte online nicht widerrufen werden.');
  return { revoked: true };
}

module.exports = { signIn, refreshProfile, getModels, revokeProfile };
