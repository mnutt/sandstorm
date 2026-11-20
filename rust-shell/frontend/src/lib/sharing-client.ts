import { ShareGrantKind, type ShareRole, type SharingState as WireState } from '../generated/shell';
import type { SharingState } from './sharing';

export function writeRole(value: string, out: ShareRole) {
  if (value === 'all') out.all = true;
  else if (value === 'none') out.none = true;
  else if (/^(0|[1-9][0-9]*)$/.test(value) && Number(value) <= 0xffffffff) out.roleId = Number(value);
  else throw new Error('Choose a permission role.');
}
function role(value: ShareRole): string {
  if (value._isAll) return 'all';
  if (value._isNone) return 'none';
  if (value._isRoleId) return String(value.roleId);
  throw new Error('Invalid sharing role.');
}
export function sharingState(value: WireState): SharingState {
  return {
    roles: [...value.roles].map(row => ({key:String(row.id),title:row.title,description:row.description})),
    defaultRole: role(value.defaultRole), owner:value.owner, private:value.private,
    grants: [...value.grants].map(row => {
      const kind = row.kind === ShareGrantKind.LINK ? 'link' : row.kind === ShareGrantKind.PERSON ? 'person'
        : row.kind === ShareGrantKind.GRAIN ? 'grain' : undefined;
      if (!kind) throw new Error('Invalid sharing grant.');
      return {id:row.id,label:row.label,role:row._isCustom ? 'custom' : role(row.role),kind,
        recipient:row.recipient,recipientPictureUrl:row.recipientPictureUrl,
        editable:row.editable,inherited:row.inherited,created:row.created};
    }),
  };
}
