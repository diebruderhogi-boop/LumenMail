const crypto = require('node:crypto');
const http = require('node:http');
const { shell } = require('electron');

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const MICROSOFT_ROOT = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GOOGLE_SCOPE = 'https://mail.google.com/';
const MICROSOFT_SCOPES = [
  'offline_access', 'openid', 'profile', 'email',
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send'
];

function randomUrlSafe(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

async function postForm(url, fields, label) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(20000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = result.error_description || result.error || `${label} (HTTP ${response.status})`;
    const error = new Error(String(details).replace(/[\r\n]+/g, ' ').slice(0, 300));
    error.code = result.error || '';
    throw error;
  }
  return result;
}

async function exchangeGoogleCode({ clientId, code, verifier, redirectUri }) {
  return postForm(GOOGLE_TOKEN, {
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  }, 'Google-Anmeldung fehlgeschlagen');
}

async function googleUserInfo(accessToken) {
  const response = await fetch(GOOGLE_USERINFO, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error('Google hat die bestätigte E-Mail-Adresse nicht zurückgegeben.');
  return response.json();
}

async function beginGoogleSignIn({ clientId, email = '' }) {
  if (!clientId) throw new Error('Die Google-Anmeldung ist noch nicht für LumenMail eingerichtet. Es fehlt die Google-App-ID.');
  const state = randomUrlSafe();
  const verifier = randomUrlSafe(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const redirectUri = `http://127.0.0.1:${server.address().port}/oauth/callback`;
  let callbackTimer;
  let rejectCallback;
  const callback = new Promise((resolve, reject) => {
    rejectCallback = reject;
    callbackTimer = setTimeout(() => reject(new Error('Die Google-Anmeldung ist abgelaufen. Bitte versuche es erneut.')), 5 * 60 * 1000);
    server.on('request', (request, response) => {
      const current = new URL(request.url, redirectUri);
      if (current.pathname !== '/oauth/callback') {
        response.writeHead(404).end('Not found');
        return;
      }
      if (current.searchParams.get('state') !== state) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end('Die Anmeldung konnte nicht sicher bestätigt werden. Dieses Fenster kann geschlossen werden.');
        reject(new Error('Die Sicherheitsprüfung der Google-Anmeldung ist fehlgeschlagen.'));
        return;
      }
      const providerError = current.searchParams.get('error');
      if (providerError) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end('<!doctype html><meta charset="utf-8"><title>LumenMail</title><p>Die Google-Anmeldung wurde nicht abgeschlossen. Dieses Fenster kann geschlossen werden.</p>');
        reject(new Error(current.searchParams.get('error_description') || 'Die Google-Anmeldung wurde abgebrochen.'));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end('<!doctype html><meta charset="utf-8"><title>LumenMail</title><p>Google wurde mit LumenMail verbunden. Dieses Fenster kann geschlossen werden.</p>');
      resolve(current.searchParams.get('code') || '');
    });
  });
  callback.catch(() => {});
  const authorizationUrl = new URL(GOOGLE_AUTHORIZE);
  authorizationUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: `openid email ${GOOGLE_SCOPE}`,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    ...(email ? { login_hint: email } : {})
  }).toString();

  let completion;
  try {
    await shell.openExternal(authorizationUrl.toString());
    completion = (async () => {
      const code = await callback;
      if (!code) throw new Error('Google hat keinen Anmeldecode zurückgegeben.');
      const tokens = await exchangeGoogleCode({ clientId, code, verifier, redirectUri });
      if (!tokens.refresh_token) throw new Error('Google hat kein dauerhaftes Zugriffstoken freigegeben. Bitte entferne LumenMail unter deinem Google-Konto aus den Drittanbieter-Zugriffen und melde dich erneut an.');
      const profile = await googleUserInfo(tokens.access_token);
      return {
        provider: 'gmail', clientId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || '',
        expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
        email: String(profile.email || '').toLowerCase(),
        emailVerified: Boolean(profile.email_verified)
      };
    })();
    completion.catch(() => {});
  } catch (error) {
    rejectCallback?.(error);
    server.close();
    throw error;
  }

  const cancel = () => rejectCallback?.(new Error('Die Anmeldung wurde abgebrochen.'));
  completion = completion.finally(() => {
    clearTimeout(callbackTimer);
    try { server.close(); } catch {}
  });
  completion.catch(() => {});
  return { completion, cancel };
}

async function requestMicrosoftDeviceCode({ clientId }) {
  if (!clientId) throw new Error('Die Outlook-Anmeldung ist noch nicht für LumenMail eingerichtet. Es fehlt die Microsoft-App-ID.');
  const result = await postForm(`${MICROSOFT_ROOT}/devicecode`, {
    client_id: clientId,
    scope: MICROSOFT_SCOPES.join(' '),
    mkt: 'de-DE'
  }, 'Microsoft-Anmeldung konnte nicht gestartet werden');
  if (!result.device_code || !result.user_code || !result.verification_uri) {
    throw new Error('Microsoft hat keinen vollständigen Anmeldecode zurückgegeben.');
  }
  return {
    deviceCode: result.device_code,
    userCode: result.user_code,
    verificationUri: result.verification_uri,
    expiresIn: Number(result.expires_in || 900),
    interval: Number(result.interval || 5)
  };
}

async function waitForMicrosoftDeviceCode({ clientId, deviceCode, interval, expiresIn, signal }) {
  const startedAt = Date.now();
  let delaySeconds = Math.max(2, Number(interval) || 5);
  while (Date.now() - startedAt < Math.max(60, expiresIn) * 1000) {
    if (signal?.aborted) throw new Error('Die Anmeldung wurde abgebrochen.');
    await new Promise((resolve, reject) => {
      let timeout;
      const abort = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); reject(new Error('Die Anmeldung wurde abgebrochen.')); };
      timeout = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delaySeconds * 1000);
      signal?.addEventListener('abort', abort, { once: true });
    });
    if (signal?.aborted) throw new Error('Die Anmeldung wurde abgebrochen.');
    try {
      const tokens = await postForm(`${MICROSOFT_ROOT}/token`, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: deviceCode
      }, 'Microsoft-Anmeldung fehlgeschlagen');
      if (!tokens.access_token) throw new Error('Microsoft hat kein Zugriffstoken zurückgegeben.');
      return {
        provider: 'outlook', clientId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || '',
        expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000
      };
    } catch (error) {
      if (error.code === 'authorization_pending') continue;
      if (error.code === 'slow_down') { delaySeconds += 5; continue; }
      if (error.code === 'authorization_declined') throw new Error('Die Microsoft-Anmeldung wurde abgelehnt.');
      if (error.code === 'expired_token') throw new Error('Der Microsoft-Code ist abgelaufen. Bitte starte die Anmeldung erneut.');
      throw error;
    }
  }
  throw new Error('Der Microsoft-Code ist abgelaufen. Bitte starte die Anmeldung erneut.');
}

async function refreshTokens(secret) {
  if (!secret?.refreshToken || !secret?.clientId || !['gmail', 'outlook'].includes(secret.provider)) {
    throw new Error('Die E-Mail-Anmeldung ist abgelaufen. Bitte verbinde das Konto erneut.');
  }
  const endpoint = secret.provider === 'gmail' ? GOOGLE_TOKEN : `${MICROSOFT_ROOT}/token`;
  const scope = secret.provider === 'outlook' ? { scope: MICROSOFT_SCOPES.join(' ') } : {};
  const tokens = await postForm(endpoint, {
    client_id: secret.clientId,
    grant_type: 'refresh_token',
    refresh_token: secret.refreshToken,
    ...scope
  }, 'Das E-Mail-Zugriffstoken konnte nicht erneuert werden');
  return {
    ...secret,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || secret.refreshToken,
    expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000
  };
}

module.exports = {
  GOOGLE_SCOPE, MICROSOFT_SCOPES,
  beginGoogleSignIn, requestMicrosoftDeviceCode, waitForMicrosoftDeviceCode, refreshTokens
};

