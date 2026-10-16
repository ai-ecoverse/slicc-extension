export interface OAuthRequestMsg {
  type: 'oauth-request';
  providerId: string;
  authorizeUrl: string;
  interactive?: boolean;
}

export interface OAuthResultMsg {
  type: 'oauth-result';
  providerId: string;
  code?: string;
  state?: string;
  error?: string;
  redirectUrl?: string;
}

export interface NavigateLickMsg {
  type: 'navigate-lick';
  url: string;
  verb: 'handoff' | 'upskill';
  target: string;
  instruction?: string;
  branch?: string;
  path?: string;
  title?: string;
  tabId?: number;
}

export type ExtensionMessage =
  | { source: 'offscreen'; payload: { type: string } }
  | { source: 'panel'; payload: OAuthRequestMsg | { type: string } }
  | { source: 'service-worker'; payload: OAuthResultMsg | NavigateLickMsg };
