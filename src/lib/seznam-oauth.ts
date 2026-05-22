import type { AuthTokens, User } from './types';

const AUTH_URL = 'https://login.szn.cz/api/v1/oauth/auth';
const TOKEN_URL = 'https://login.szn.cz/api/v1/oauth/token';
const USERINFO_URL = 'https://login.szn.cz/api/v1/user';

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLen: number): string {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

async function sha256(input: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return base64url(new Uint8Array(hash));
}

export interface LoginResult {
  user: User;
  auth: AuthTokens;
}

export async function login(): Promise<LoginResult> {
  const clientId = import.meta.env.VITE_SEZNAM_CLIENT_ID;
  if (!clientId) {
    throw new Error('VITE_SEZNAM_CLIENT_ID is not set. Add it to .env.local and rebuild.');
  }

  const redirectUri = chrome.identity.getRedirectURL();
  const codeVerifier = randomString(48);
  const codeChallenge = await sha256(codeVerifier);
  const state = randomString(12);

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', 'identity');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const redirectResponse = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true
  });
  if (!redirectResponse) throw new Error('OAuth flow returned no response');

  const respUrl = new URL(redirectResponse);
  const err = respUrl.searchParams.get('error');
  if (err) throw new Error(`OAuth error: ${err}`);
  const returnedState = respUrl.searchParams.get('state');
  if (returnedState !== state) throw new Error('OAuth state mismatch — possible CSRF');
  const code = respUrl.searchParams.get('code');
  if (!code) throw new Error('OAuth: no authorization code returned');

  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier
  });
  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody.toString()
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    throw new Error(`Token exchange failed: ${tokenRes.status} ${text}`);
  }
  const tokenJson = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const userRes = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` }
  });
  if (!userRes.ok) {
    throw new Error(`Userinfo failed: ${userRes.status}`);
  }
  // Privacy: only consume `oauth_user_id`. The identity scope also returns
  // email + firstname + lastname, but we never want to persist or display them,
  // so they're not even read into a typed variable.
  const u = (await userRes.json()) as { oauth_user_id: string };

  return {
    user: { oauthUserId: u.oauth_user_id },
    auth: {
      accessToken: tokenJson.access_token,
      refreshToken: tokenJson.refresh_token ?? '',
      expiresAt: Math.floor(Date.now() / 1000) + (tokenJson.expires_in ?? 3600)
    }
  };
}

/**
 * Exchange a refresh token for a fresh access token. Returns null if the
 * refresh fails (e.g. token revoked) — caller should force re-login.
 */
export async function refreshAccessToken(
  refreshToken: string
): Promise<AuthTokens | null> {
  const clientId = import.meta.env.VITE_SEZNAM_CLIENT_ID;
  if (!clientId || !refreshToken) return null;
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId
    });
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + (j.expires_in ?? 3600)
    };
  } catch {
    return null;
  }
}
