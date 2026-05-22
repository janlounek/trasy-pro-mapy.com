import type { AuthTokens, RouteFolder, SavedRoute, User } from './types';

const ROUTES_KEY = 'routes';
const USER_KEY = 'user';
const SHOW_ON_MAP_KEY = 'showOnMap';
const FOLDERS_KEY = 'folders';
const AUTH_KEY = 'auth';

type FoldersMap = Record<string, RouteFolder[]>;

export async function getShowOnMap(): Promise<boolean> {
  const o = await chrome.storage.local.get(SHOW_ON_MAP_KEY);
  const v = o[SHOW_ON_MAP_KEY];
  return v === undefined ? true : Boolean(v);
}

export async function setShowOnMap(v: boolean): Promise<void> {
  await chrome.storage.local.set({ [SHOW_ON_MAP_KEY]: v });
}

type RoutesMap = Record<string, SavedRoute[]>;

export async function getUser(): Promise<User | null> {
  const o = await chrome.storage.local.get(USER_KEY);
  return (o[USER_KEY] as User | undefined) ?? null;
}

export async function setUser(user: User | null): Promise<void> {
  await chrome.storage.local.set({ [USER_KEY]: user });
}

export async function getRoutes(oauthUserId: string): Promise<SavedRoute[]> {
  const o = await chrome.storage.local.get(ROUTES_KEY);
  const map = (o[ROUTES_KEY] as RoutesMap | undefined) ?? {};
  return map[oauthUserId] ?? [];
}

export async function saveRoute(oauthUserId: string, route: SavedRoute): Promise<void> {
  const o = await chrome.storage.local.get(ROUTES_KEY);
  const map = (o[ROUTES_KEY] as RoutesMap | undefined) ?? {};
  const list = map[oauthUserId] ?? [];
  list.push(route);
  map[oauthUserId] = list;
  await chrome.storage.local.set({ [ROUTES_KEY]: map });
}

export async function deleteRoute(oauthUserId: string, routeId: string): Promise<void> {
  const o = await chrome.storage.local.get(ROUTES_KEY);
  const map = (o[ROUTES_KEY] as RoutesMap | undefined) ?? {};
  const list = map[oauthUserId] ?? [];
  map[oauthUserId] = list.filter((r) => r.id !== routeId);
  await chrome.storage.local.set({ [ROUTES_KEY]: map });
}

export async function updateRoute(
  oauthUserId: string,
  routeId: string,
  updates: Partial<SavedRoute>
): Promise<SavedRoute | null> {
  const o = await chrome.storage.local.get(ROUTES_KEY);
  const map = (o[ROUTES_KEY] as RoutesMap | undefined) ?? {};
  const list = map[oauthUserId] ?? [];
  const idx = list.findIndex((r) => r.id === routeId);
  if (idx === -1) return null;
  const merged: SavedRoute = { ...list[idx], ...updates, updatedAt: Date.now() };
  list[idx] = merged;
  map[oauthUserId] = list;
  await chrome.storage.local.set({ [ROUTES_KEY]: map });
  return merged;
}

// ----- Folder CRUD -----

export async function getFolders(oauthUserId: string): Promise<RouteFolder[]> {
  const o = await chrome.storage.local.get(FOLDERS_KEY);
  const map = (o[FOLDERS_KEY] as FoldersMap | undefined) ?? {};
  return map[oauthUserId] ?? [];
}

export async function saveFolder(
  oauthUserId: string,
  folder: RouteFolder
): Promise<void> {
  const o = await chrome.storage.local.get(FOLDERS_KEY);
  const map = (o[FOLDERS_KEY] as FoldersMap | undefined) ?? {};
  const list = map[oauthUserId] ?? [];
  list.push(folder);
  map[oauthUserId] = list;
  await chrome.storage.local.set({ [FOLDERS_KEY]: map });
}

export async function updateFolder(
  oauthUserId: string,
  folderId: string,
  updates: Partial<RouteFolder>
): Promise<RouteFolder | null> {
  const o = await chrome.storage.local.get(FOLDERS_KEY);
  const map = (o[FOLDERS_KEY] as FoldersMap | undefined) ?? {};
  const list = map[oauthUserId] ?? [];
  const idx = list.findIndex((f) => f.id === folderId);
  if (idx === -1) return null;
  const merged: RouteFolder = { ...list[idx], ...updates };
  list[idx] = merged;
  map[oauthUserId] = list;
  await chrome.storage.local.set({ [FOLDERS_KEY]: map });
  return merged;
}

export async function deleteFolder(oauthUserId: string, folderId: string): Promise<void> {
  const o = await chrome.storage.local.get(FOLDERS_KEY);
  const map = (o[FOLDERS_KEY] as FoldersMap | undefined) ?? {};
  const list = map[oauthUserId] ?? [];
  map[oauthUserId] = list.filter((f) => f.id !== folderId);
  await chrome.storage.local.set({ [FOLDERS_KEY]: map });
}

// ----- OAuth token storage -----

export async function getAuth(): Promise<AuthTokens | null> {
  const o = await chrome.storage.local.get(AUTH_KEY);
  return (o[AUTH_KEY] as AuthTokens | undefined) ?? null;
}

export async function setAuth(auth: AuthTokens | null): Promise<void> {
  if (auth) {
    await chrome.storage.local.set({ [AUTH_KEY]: auth });
  } else {
    await chrome.storage.local.remove(AUTH_KEY);
  }
}
