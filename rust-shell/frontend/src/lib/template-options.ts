import type { TemplateOptions } from '../generated/shell';
import { record, type TemplateRequest } from './protocol';

type Role = { none?: null; allAccess?: null; roleId?: number; addPermissions?: boolean[]; removePermissions?: boolean[] };
type Resource = { type: string; body: string; language?: string; encoding?: string };
type Discovery = { options?: { dav?: string[] }; resources?: Record<string, Resource> };
export interface TokenOptions { petname: string; roleAssignment: Role; forSharing: boolean; unauthenticated?: Discovery }

function object(value: unknown, keys: string[]): Record<string, unknown> {
  const result = record(value);
  if (!result || Object.keys(result).some(key => !keys.includes(key))) invalid();
  return result;
}
function invalid(): never { throw new Error('Invalid template request.'); }

// Validate before encoding so unsupported fields cannot silently lose authority
// restrictions. Header/path syntax and discovery size are checked by Meteor.
export function tokenOptions(call: TemplateRequest): TokenOptions {
  const role = object(call.roleAssignment ?? { allAccess: null },
    ['none', 'allAccess', 'roleId', 'addPermissions', 'removePermissions']);
  if (['none', 'allAccess', 'roleId'].filter(key => role[key] !== undefined).length > 1 ||
      (role.none !== undefined && role.none !== null) ||
      (role.allAccess !== undefined && role.allAccess !== null) ||
      (role.roleId !== undefined && (!Number.isInteger(role.roleId) || (role.roleId as number) < -2147483648 || (role.roleId as number) > 2147483647))) invalid();
  for (const key of ['addPermissions', 'removePermissions']) {
    const value = role[key];
    if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'boolean'))) invalid();
  }
  if (call.unauthenticated !== undefined) {
    const discovery = object(call.unauthenticated, ['options', 'resources']);
    if (discovery.options !== undefined) {
      const options = object(discovery.options, ['dav']);
      if (options.dav !== undefined && (!Array.isArray(options.dav) || options.dav.some(item => typeof item !== 'string'))) invalid();
    }
    if (discovery.resources !== undefined) {
      const resources = record(discovery.resources);
      if (!resources) invalid();
      for (const value of Object.values(resources)) {
        const resource = object(value, ['type', 'body', 'language', 'encoding']);
        if (typeof resource.type !== 'string' || typeof resource.body !== 'string' ||
            (resource.language !== undefined && typeof resource.language !== 'string') ||
            (resource.encoding !== undefined && typeof resource.encoding !== 'string')) invalid();
      }
    }
  }
  return { petname: call.petname || 'connected external app', roleAssignment: role as Role,
    forSharing: call.forSharing || false, unauthenticated: call.unauthenticated as Discovery | undefined };
}
export function writeTokenOptions(out: TemplateOptions, options: TokenOptions) {
  out.petname = options.petname;
  out.forSharing = options.forSharing;
  const role = out._initRole(), input = options.roleAssignment;
  if (input.allAccess === null) role.allAccess = true;
  else if (input.roleId !== undefined) role.roleId = input.roleId;
  else role.none = true;
  if (input.addPermissions) {
    const list = role._initAddPermissions(input.addPermissions.length);
    input.addPermissions.forEach((value, index) => list.set(index, value));
  }
  if (input.removePermissions) {
    const list = role._initRemovePermissions(input.removePermissions.length);
    input.removePermissions.forEach((value, index) => list.set(index, value));
  }
  const discovery = options.unauthenticated;
  if (discovery === undefined) return;
  const target = out._initUnauthenticated();
  if (discovery.options !== undefined) {
    const targetOptions = target._initOptions();
    if (discovery.options.dav !== undefined) {
      const list = targetOptions._initDav(discovery.options.dav.length);
      discovery.options.dav.forEach((value, index) => list.set(index, value));
    }
  }
  if (discovery.resources !== undefined) {
    const entries = Object.entries(discovery.resources), list = target._initResources(entries.length);
    entries.forEach(([path, value], index) => {
      const resource = list.get(index);
      resource.path = path;
      resource.type = value.type;
      resource.body = value.body;
      if (value.language !== undefined) resource.language = value.language;
      if (value.encoding !== undefined) resource.encoding = value.encoding;
    });
  }
}
