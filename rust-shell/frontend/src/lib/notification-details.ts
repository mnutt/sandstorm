export type NotificationDetails =
  | {kind:'stats';enabled:boolean|null;sample:string;sampleLimited:boolean}
  | {kind:'referrals';enabled:boolean;pending:{name:string;pictureUrl:string}[];completed:{name:string;pictureUrl:string}[];limited:boolean}
  | {kind:'identity'};
