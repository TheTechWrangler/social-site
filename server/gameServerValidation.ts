import {
  booleanField,
  enumField,
  integerField,
  stringField,
  validatedObjectBody,
  type RequestBody,
} from './requestValidation.js';

const SERVER_NAME_MAX = 120;
const SERVER_SHORT_FIELD_MAX = 120;
const SERVER_HOST_MAX = 255;
const SERVER_LONG_FIELD_MAX = 2000;
const SERVER_URL_MAX = 2048;
const SERVER_STATUSES = ['online', 'offline', 'maintenance', 'unknown'] as const;
const MUTABLE_FIELDS = [
  'name', 'description', 'connectionHost', 'connectionPort', 'platform', 'status',
  'maxPlayers', 'currentPlayers', 'isFeatured', 'isActive', 'joinInstructions',
  'rulesSummary', 'discordUrl', 'websiteUrl', 'serverType', 'playStyle',
  'regionOrTimezone',
] as const;

export interface GameServerMutableInput {
  name?: string;
  description?: string;
  connectionHost?: string;
  connectionPort?: number | null;
  platform?: string;
  status?: typeof SERVER_STATUSES[number];
  maxPlayers?: number | null;
  currentPlayers?: number;
  isFeatured?: boolean;
  isActive?: boolean;
  joinInstructions?: string;
  rulesSummary?: string;
  discordUrl?: string;
  websiteUrl?: string;
  serverType?: string;
  playStyle?: string;
  regionOrTimezone?: string;
}

export interface GameServerCreateInput extends Required<Omit<GameServerMutableInput, 'connectionPort' | 'maxPlayers'>> {
  gameId: number;
  connectionPort: number | null;
  maxPlayers: number | null;
}

function optionalString(body: RequestBody, key: string, maxLength: number): string | undefined {
  const value = stringField(body, key, { maxLength, allowEmpty: true });
  return value === null ? undefined : value;
}

function parseMutable(body: RequestBody, requireName: boolean): GameServerMutableInput {
  const parsed: GameServerMutableInput = {};
  const name = stringField(body, 'name', { required: requireName, maxLength: SERVER_NAME_MAX });
  const description = optionalString(body, 'description', SERVER_LONG_FIELD_MAX);
  const connectionHost = optionalString(body, 'connectionHost', SERVER_HOST_MAX);
  const connectionPort = integerField(body, 'connectionPort', { min: 1, max: 65535, nullable: true });
  const platform = optionalString(body, 'platform', SERVER_SHORT_FIELD_MAX);
  const status = enumField(body, 'status', SERVER_STATUSES);
  const maxPlayers = integerField(body, 'maxPlayers', { min: 1, max: 1_000_000, nullable: true });
  const currentPlayers = integerField(body, 'currentPlayers', { min: 0, max: 1_000_000 });
  const isFeatured = booleanField(body, 'isFeatured');
  const isActive = booleanField(body, 'isActive');
  const joinInstructions = optionalString(body, 'joinInstructions', SERVER_LONG_FIELD_MAX);
  const rulesSummary = optionalString(body, 'rulesSummary', SERVER_LONG_FIELD_MAX);
  const discordUrl = optionalString(body, 'discordUrl', SERVER_URL_MAX);
  const websiteUrl = optionalString(body, 'websiteUrl', SERVER_URL_MAX);
  const serverType = optionalString(body, 'serverType', SERVER_SHORT_FIELD_MAX);
  const playStyle = optionalString(body, 'playStyle', SERVER_SHORT_FIELD_MAX);
  const regionOrTimezone = optionalString(body, 'regionOrTimezone', SERVER_SHORT_FIELD_MAX);

  if (name !== undefined) parsed.name = name;
  if (description !== undefined) parsed.description = description;
  if (connectionHost !== undefined) parsed.connectionHost = connectionHost;
  if (connectionPort !== undefined) parsed.connectionPort = connectionPort;
  if (platform !== undefined) parsed.platform = platform;
  if (status !== undefined) parsed.status = status;
  if (maxPlayers !== undefined) parsed.maxPlayers = maxPlayers;
  if (currentPlayers !== undefined) parsed.currentPlayers = currentPlayers;
  if (isFeatured !== undefined) parsed.isFeatured = isFeatured;
  if (isActive !== undefined) parsed.isActive = isActive;
  if (joinInstructions !== undefined) parsed.joinInstructions = joinInstructions;
  if (rulesSummary !== undefined) parsed.rulesSummary = rulesSummary;
  if (discordUrl !== undefined) parsed.discordUrl = discordUrl;
  if (websiteUrl !== undefined) parsed.websiteUrl = websiteUrl;
  if (serverType !== undefined) parsed.serverType = serverType;
  if (playStyle !== undefined) parsed.playStyle = playStyle;
  if (regionOrTimezone !== undefined) parsed.regionOrTimezone = regionOrTimezone;
  return parsed;
}

export function validateGameServerCreate(value: unknown): GameServerCreateInput {
  const body = validatedObjectBody(value, ['gameId', ...MUTABLE_FIELDS]);
  const gameId = integerField(body, 'gameId', { required: true, min: 1, max: Number.MAX_SAFE_INTEGER })!;
  const fields = parseMutable(body, true);
  return {
    gameId,
    name: fields.name!,
    description: fields.description ?? '',
    connectionHost: fields.connectionHost ?? '',
    connectionPort: fields.connectionPort ?? null,
    platform: fields.platform ?? '',
    status: fields.status ?? 'unknown',
    maxPlayers: fields.maxPlayers ?? null,
    currentPlayers: fields.currentPlayers ?? 0,
    isFeatured: fields.isFeatured ?? false,
    isActive: fields.isActive ?? true,
    joinInstructions: fields.joinInstructions ?? '',
    rulesSummary: fields.rulesSummary ?? '',
    discordUrl: fields.discordUrl ?? '',
    websiteUrl: fields.websiteUrl ?? '',
    serverType: fields.serverType ?? '',
    playStyle: fields.playStyle ?? '',
    regionOrTimezone: fields.regionOrTimezone ?? '',
  };
}

export function validateGameServerPatch(value: unknown): GameServerMutableInput {
  const body = validatedObjectBody(value, MUTABLE_FIELDS);
  return parseMutable(body, false);
}
