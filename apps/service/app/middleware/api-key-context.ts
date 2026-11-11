import { createContext } from 'react-router';

export type ApiKeyContext = {
  apiKeyId: string;
  appId: string;
  /** api_keys.rate_limit_per_second; null means unlimited. */
  rateLimitPerSecond: number | null;
};

export const apiKeyContext = createContext<ApiKeyContext | null>(null);
