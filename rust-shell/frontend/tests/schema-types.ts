import type { Account_ReadProfile$Results, Account_UpdateProfile$Results, Account_PreparePictureUpload$Results, AccountProfile } from '../src/generated/shell';
import type { NotificationHandle_Read$Results, NotificationHandle_SetStatisticsReporting$Results, NotificationDetails, StatisticsDetails } from '../src/generated/shell';
import type {
  Installation_Read$Results, Installer_Catalog$Results, Installer_Upload$Results,
  Account_Read$Results, GrainSession_BeginPowerbox$Results, Sharing_Read$Results, Sharing_Create$Results, SharingState, ShareLink,
  InstallationState, InstallCatalog, Url, AccountState, PowerboxState,
} from '../src/generated/shell';

// Verify the branded generic result exposed by each method, without depending
// on the generator's internal specialization class names. Equality rejects any
// and AnyPointer as well as accidentally unrelated structs.
type Equal<A,B> = (<T>()=>T extends A ? 1 : 2) extends (<T>()=>T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type InstallationPayload = Assert<Equal<Installation_Read$Results['result']['value'],InstallationState>>;
export type CatalogPayload = Assert<Equal<Installer_Catalog$Results['result']['value'],InstallCatalog>>;
export type UploadPayload = Assert<Equal<Installer_Upload$Results['result']['value'],Url>>;
export type AccountPayload = Assert<Equal<Account_Read$Results['result']['value'],AccountState>>;
export type PowerboxPayload = Assert<Equal<GrainSession_BeginPowerbox$Results['result']['value'],PowerboxState>>;

export function rejectWrongPayload(result: Installation_Read$Results, account: AccountState) {
  // @ts-expect-error Result(InstallationState) cannot contain AccountState.
  result.result.value = account;
  const packageId: string = result.result.value.packageId;
  return packageId;
}

export type SharingPayload = Assert<Equal<Sharing_Read$Results['result']['value'],SharingState>>;
export type ShareLinkPayload = Assert<Equal<Sharing_Create$Results['result']['value'],ShareLink>>;

export type NoticePayload = Assert<Equal<NotificationHandle_Read$Results['result']['value'],NotificationDetails>>;
export type StatisticsPayload = Assert<Equal<NotificationHandle_SetStatisticsReporting$Results['result']['value'],StatisticsDetails>>;

export type ProfileReadPayload = Assert<Equal<Account_ReadProfile$Results['result']['value'],AccountProfile>>;
export type ProfileEditPayload = Assert<Equal<Account_UpdateProfile$Results['result']['value'],AccountProfile>>;
export type ProfileUploadPayload = Assert<Equal<Account_PreparePictureUpload$Results['result']['value'],Url>>;
