export type NotificationDetails =
  | {kind:'stats';enabled:boolean|null;sample:string;sampleLimited:boolean}
  | {kind:'referrals';enabled:boolean;pending:string[];completed:string[];limited:boolean}
  | {kind:'identity'};
