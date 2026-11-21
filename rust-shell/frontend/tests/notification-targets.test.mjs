import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeNotificationPath, nativeNotificationAction } from '../../../shell/imports/server/rust-shell-notification-targets.mjs';

test('notification destinations preserve app paths without escaping the grain route', () => {
  assert.equal(nativeNotificationPath({grainId:'grain-1'}),'/grain/grain-1');
  assert.equal(nativeNotificationPath({grainId:'grain-1',path:'/folder/document?mode=read#comment'}),'/grain/grain-1/folder/document?mode=read#comment');
  assert.equal(nativeNotificationPath({appUpdates:{app:{packageId:'unused'}}}),'/install');
  assert.equal(nativeNotificationPath({grainId:'grain-1',path:'x'.repeat(4096)}), '/grain/grain-1/' + 'x'.repeat(4096));
  for (const path of ['../../admin','%2e%2e/other','../other','a\\b','x\n',42]) {
    assert.equal(nativeNotificationPath({grainId:'grain-1',path}),'');
  }
  for (const row of [{admin:{action:'/apps'}},{referral:true},{grainId:'../other'},{}]) {
    assert.equal(nativeNotificationPath(row),'');
  }
});

test('native notice actions are limited to recognized types', () => {
  assert.equal(nativeNotificationAction({admin:{type:'reportStats'}}),'stats');
  assert.equal(nativeNotificationAction({referral:true}),'referrals');
  assert.equal(nativeNotificationAction({identityChanges:true}),'identity');
  for (const notice of [{admin:{type:'unknown'}},{admin:{action:'/admin/stats'}},{grainId:'a',referral:true},{}]) assert.equal(nativeNotificationAction(notice),'');
});
