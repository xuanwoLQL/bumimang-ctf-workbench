import type {
  PlatformChallengeView,
  PlatformRaceView,
} from "../../../../../packages/shared-protocol/events.ts";

export interface PlatformUser {
  username: string;
  displayName: string | null;
  team: string | null;
  organization: string[];
  roles: string[];
  tokenExpiresAt: number | null;
}

export interface PlatformLoginResult {
  user: PlatformUser;
  token?: string;
}

export interface PlatformAdapter {
  readonly provider: string;
  readonly connected: boolean;
  login(username: string, password: string): Promise<PlatformLoginResult>;
  listRaces(): Promise<PlatformRaceView[]>;
  listChallenges(raceId: string): Promise<PlatformChallengeView[]>;
  challengeDetail(raceId: string, challengeId: string): Promise<PlatformChallengeView>;
  submitFlag(raceId: string, challengeId: string, flag: string): Promise<Record<string, unknown>>;
  download(urlPath: string, target: string): Promise<{ bytes: number }>;
  openScene?(raceId: string, challengeId: string): Promise<Record<string, unknown>>;
  closeScene?(raceId: string, challengeId: string): Promise<Record<string, unknown>>;
}

export type PlatformProviderId =
  | "auto"
  | "nest-cyberpeace"
  | "ctfd"
  | "ctfy";
