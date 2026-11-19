export interface PowerboxCandidate {
  key: string; title: string; detail?: string; iconSrc?: string;
  uiView?: boolean; hostedObject?: boolean; urlInput?: boolean;
  roles?: {key: string; title: string}[];
}
export type PowerboxState =
  | {status:'choices'; candidates:PowerboxCandidate[]; limited:boolean; legacy:boolean}
  | {status:'provider'; title:string; origin:string; url:string}
  | {status:'waiting'}
  | {status:'complete'; token:string; descriptor?:string};
export interface PowerboxActions {
  call(request:string, operation:'begin'|'select'|'poll'|'cancel', input?:Record<string,unknown>):Promise<PowerboxState>;
}
