// Verification happens locally against the provider JWKS: the service never
// calls the identity provider per request, only to refresh keys.
export const IDENTITY_SOURCE = `// ---------- identity ----------

const KEYCLOAK_URL = (process.env.KEYCLOAK_URL || 'http://keycloak:8080').replace(/[/]+$/, '');
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || 'arcod';
const KEYCLOAK_CLIENT = process.env.KEYCLOAK_CLIENT_ID || 'arcod-service';
const KEYCLOAK_SECRET = process.env.KEYCLOAK_CLIENT_SECRET || 'arcod-secret';
const KEYCLOAK_ADMIN_ROLE = process.env.KEYCLOAK_ADMIN_ROLE || 'admin';
const AUTH_MEMORY = process.env.AUTH_DRIVER === 'memory';

const jwksCache = { keys: null, at: 0 };
const adminCache = { token: null, at: 0 };

async function identityJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error('identity ' + response.status + ' ' + url);
  return response.json();
}

async function signingKey(kid) {
  if (!jwksCache.keys || Date.now() - jwksCache.at > 300000) {
    const data = await identityJson(KEYCLOAK_URL + '/realms/' + KEYCLOAK_REALM + '/protocol/openid-connect/certs');
    jwksCache.keys = data.keys || [];
    jwksCache.at = Date.now();
  }
  const jwk = jwksCache.keys.find((item) => !kid || item.kid === kid) || jwksCache.keys[0];
  if (!jwk) throw new Error('identity: no signing keys');
  return createPublicKey({ key: jwk, format: 'jwk' });
}

function memoryActor(req) {
  const id = req.headers['x-actor'];
  if (!id) return null;
  return {
    id: String(id),
    name: String(req.headers['x-actor-name'] || id),
    admin: String(req.headers['x-admin'] || '') === 'true',
    roles: [],
  };
}

async function actorFrom(req) {
  if (AUTH_MEMORY) return memoryActor(req);
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  const parts = header.slice(7).split('.');
  if (parts.length !== 3) return null;
  let head;
  let claims;
  try {
    head = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (error) {
    return null;
  }
  const key = await signingKey(head.kid);
  const signed = Buffer.from(parts[0] + '.' + parts[1], 'utf8');
  if (!verify('RSA-SHA256', signed, key, Buffer.from(parts[2], 'base64url'))) return null;
  if (claims.exp && claims.exp * 1000 <= Date.now()) return null;
  const roles = (claims.realm_access && claims.realm_access.roles) || [];
  return {
    id: claims.sub,
    name: claims.preferred_username || claims.email || claims.sub,
    admin: roles.includes(KEYCLOAK_ADMIN_ROLE),
    roles,
  };
}

async function serviceAccountToken() {
  if (adminCache.token && Date.now() - adminCache.at < 60000) return adminCache.token;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: KEYCLOAK_CLIENT,
    client_secret: KEYCLOAK_SECRET,
  });
  const data = await identityJson(KEYCLOAK_URL + '/realms/' + KEYCLOAK_REALM + '/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  adminCache.token = data.access_token;
  adminCache.at = Date.now();
  return adminCache.token;
}

async function listUsers() {
  if (AUTH_MEMORY) {
    return [
      { id: 'u-andrey', name: 'andrey' },
      { id: 'u-vika', name: 'vika' },
      { id: 'u-guest', name: 'guest' },
    ];
  }
  const token = await serviceAccountToken();
  const data = await identityJson(KEYCLOAK_URL + '/admin/realms/' + KEYCLOAK_REALM + '/users?max=200', {
    headers: { authorization: 'Bearer ' + token },
  });
  return data.map((user) => ({ id: user.id, name: user.username }));
}
`;
