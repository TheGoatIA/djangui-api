/**
 * Client HTTP de test au-dessus de supertest.
 *
 * Chaque requête reçoit une IP source distincte (X-Forwarded-For, l'app fait
 * `trust proxy 1`) : les tests fonctionnels ne se bloquent pas mutuellement sur le
 * rate-limit par IP. Les tests de rate-limit, eux, fixent une IP avec `fromIp`.
 */
import request from 'supertest';
import app from '../../src/app';
import { accessTokenFor } from './factories';

let ipSeq = 0;
const nextIp = () => {
  ipSeq += 1;
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
};

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface ApiOptions {
  token?: string;
  user?: { _id: unknown };
  ip?: string;
  headers?: Record<string, string>;
}

export function api(method: Method, url: string, opts: ApiOptions = {}) {
  const fullUrl =
    url.startsWith('/api') || url.startsWith('/health') || url.startsWith('/metrics')
      ? url
      : `/api/v1${url}`;
  let req = request(app)
    [method](fullUrl)
    .set('X-Forwarded-For', opts.ip ?? nextIp());
  const token = opts.token ?? (opts.user ? accessTokenFor(opts.user) : undefined);
  if (token) req = req.set('Authorization', `Bearer ${token}`);
  for (const [k, v] of Object.entries(opts.headers ?? {})) req = req.set(k, v);
  return req;
}

/** Client lié à un utilisateur : `as(user).get('/auth/me')`. */
export function as(user: { _id: unknown } | null, base: Omit<ApiOptions, 'user'> = {}) {
  const o = user ? { ...base, user } : base;
  return {
    get: (u: string, x: ApiOptions = {}) => api('get', u, { ...o, ...x }),
    post: (u: string, x: ApiOptions = {}) => api('post', u, { ...o, ...x }),
    put: (u: string, x: ApiOptions = {}) => api('put', u, { ...o, ...x }),
    patch: (u: string, x: ApiOptions = {}) => api('patch', u, { ...o, ...x }),
    delete: (u: string, x: ApiOptions = {}) => api('delete', u, { ...o, ...x }),
  };
}

export const anon = () => as(null);
export { app };
