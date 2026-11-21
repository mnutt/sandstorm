import type { ShellConnection } from './connection';
import { unwrap } from './results';
export type GrainOperation = 'trash' | 'restore' | 'remove' | 'restart';
export async function changeGrain(connection:ShellConnection,id:string,operation:GrainOperation) {
  const handle=connection.shell.grain(p=>{p.grainId=id;}).getHandle();
  try { unwrap((await connection.run(handle[operation]().promise(),'Update grain')).result); }
  finally { handle.client.close(); }
}
export async function grainDisposition(connection:ShellConnection,id:string) {
  const handle=connection.shell.grain(p=>{p.grainId=id;}).getHandle();
  try { return unwrap((await connection.run(handle.read().promise(),'Check grain')).result).disposition; }
  finally { handle.client.close(); }
}
