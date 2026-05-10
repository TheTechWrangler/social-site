declare module 'passport-steam' {
  import { Strategy as PassportStrategy } from 'passport';
  
  interface SteamStrategyOptions {
    returnURL: string;
    realm: string;
    apiKey: string;
  }

  export class Strategy extends PassportStrategy {
    constructor(options: SteamStrategyOptions, verify: (identifier: any, profile: any, done: (err: any, user?: any) => void) => void);
  }
}
