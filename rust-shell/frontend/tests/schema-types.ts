import type {
  Installer_Status$Results, Installer_Catalog$Results, Installer_Upload$Results,
  Account_Read$Results, GrainSession_BeginPowerbox$Results,
  InstallationState, InstallCatalog, Url, AccountState, PowerboxState,
} from '../src/generated/shell';

// Verify the branded generic result exposed by each method, without depending
// on the generator's internal specialization class names. Equality rejects any
// and AnyPointer as well as accidentally unrelated structs.
type Equal<A,B> = (<T>()=>T extends A ? 1 : 2) extends (<T>()=>T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type InstallationPayload = Assert<Equal<Installer_Status$Results['result']['value'],InstallationState>>;
export type CatalogPayload = Assert<Equal<Installer_Catalog$Results['result']['value'],InstallCatalog>>;
export type UploadPayload = Assert<Equal<Installer_Upload$Results['result']['value'],Url>>;
export type AccountPayload = Assert<Equal<Account_Read$Results['result']['value'],AccountState>>;
export type PowerboxPayload = Assert<Equal<GrainSession_BeginPowerbox$Results['result']['value'],PowerboxState>>;

export function rejectWrongPayload(result: Installer_Status$Results, account: AccountState) {
  // @ts-expect-error Result(InstallationState) cannot contain AccountState.
  result.result.value = account;
  const packageId: string = result.result.value.packageId;
  return packageId;
}
