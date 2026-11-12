import { createContext, useContext } from 'react';
import type { AppSpec } from '../types';
import type { Api, AppWindow } from './api';

/** Where the app runs: its window and document (the app can be booted into any document), the spec and the API client. */
export interface AppEnv {
  view: AppWindow;
  doc: Document;
  spec: AppSpec;
  api: Api;
}

export const EnvContext = createContext<AppEnv | null>(null);

export function useEnv(): AppEnv {
  const env = useContext(EnvContext);
  if (!env) throw new Error('@c2c/ui: useEnv outside the app');
  return env;
}
