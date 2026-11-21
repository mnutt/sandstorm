export interface PowerboxCandidate {
  key: string; title: string; detail?: string; iconSrc?: string;
  uiView?: boolean; hostedObject?: boolean; urlInput?: boolean; emailInput?: boolean; oauthProvider?: 'github' | 'google';
  roles?: {key: string; title: string}[];
}
export type PowerboxState =
  | {status:'nested';view:PowerboxState}
  | {status:'choices'; candidates:PowerboxCandidate[]; limited:boolean; legacy:boolean}
  | {status:'provider'; title:string; origin:string; url:string}
  | {status:'oauth';request:string;url:string}
  | {status:'email'; address:string}
  | {status:'waiting'}
  | {status:'complete'; token:string; descriptor?:string};
export interface PowerboxActions {
  call(request:string, operation:'begin'|'select'|'poll'|'cancel', input?:Record<string,unknown>):Promise<PowerboxState>;
}
