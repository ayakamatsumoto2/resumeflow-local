/**
 * ResumeFLOW Local Edition — 本地单用户替身，取代 @logto/react。
 * 本地版不需要登录：始终视为「已登录的本机用户」。
 * 所有函数引用保持稳定，避免触发原有鉴权状态机的重复校验。
 */
import React from 'react';

export const LOCAL_USER_ID = 'local-user';

export type LogtoConfig = Record<string, unknown>;

export const UserScope = {
  Profile: 'profile',
  Email: 'email',
  Phone: 'phone',
  Identities: 'identities',
} as const;

const base64Url = (value: string) => btoa(value)
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

const claims = {
  sub: LOCAL_USER_ID,
  iss: 'resumeflow-local',
  aud: 'resumeflow-local',
  iat: 1_700_000_000,
  // 本地令牌不过期（2099 年）。
  exp: 4_070_908_800,
  name: '',
};

const LOCAL_ID_TOKEN = [
  base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' })),
  base64Url(JSON.stringify(claims)),
  'local',
].join('.');

const getIdToken = async () => LOCAL_ID_TOKEN;
const getAccessToken = async () => LOCAL_ID_TOKEN;
const getIdTokenClaims = async () => ({ ...claims });
const fetchUserInfo = async () => ({ sub: LOCAL_USER_ID });
const noop = async () => undefined;

const logtoValue = Object.freeze({
  isAuthenticated: true,
  isLoading: false,
  error: undefined as Error | undefined,
  signIn: noop as (...args: unknown[]) => Promise<void>,
  signOut: noop as (...args: unknown[]) => Promise<void>,
  getIdToken,
  getAccessToken,
  getIdTokenClaims,
  fetchUserInfo,
  clearAllTokens: noop,
  clearAccessToken: noop,
  getRefreshToken: async () => null,
  getOrganizationToken: async () => null,
  getOrganizationTokenClaims: async () => undefined,
  getAccessTokenClaims: async () => ({ ...claims }),
  handleSignInCallback: noop,
});

export const useLogto = () => logtoValue;

export const useHandleSignInCallback = (_callback?: () => void) => ({
  isLoading: false,
  isAuthenticated: true,
  error: undefined as Error | undefined,
});

export const LogtoProvider: React.FC<{ config?: LogtoConfig; children?: React.ReactNode }> = ({ children }) => (
  <>{children}</>
);
