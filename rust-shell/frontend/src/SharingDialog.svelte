<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { Tabs } from 'bits-ui';
  import Modal from './components/ui/Modal.svelte';
  import Button from './components/ui/Button.svelte';
  import TextInput from './components/ui/TextInput.svelte';
  import NativeSelect from './components/ui/NativeSelect.svelte';
  import LoadingStatus from './components/ui/LoadingStatus.svelte';
  import { sharingUrl, type SharingActions, type SharingRequest, type SharingState, type ShareGrant } from './lib/sharing';
  let { request, actions, title, onclose }: { request: SharingRequest; actions: SharingActions; title: string; onclose: () => void } = $props();
  let open = $state(true);
  let snapshot = $state<SharingState>();
  let tab = $state(untrack(() => request.mode));
  let loading = $state(true);
  let busy = $state(false);
  let error = $state('');
  let label = $state('');
  let role = $state('none');
  let link = $state('');
  let copied = $state(false);
  let editing = $state<ShareGrant>();
  let editLabel = $state('');
  let editRole = $state('none');
  let revoking = $state<ShareGrant>();
  let alive = true;
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  $effect(() => { if (!open) onclose(); });
  onMount(() => {
    void refresh(true);
    return () => { alive = false; link = ''; };
  });
  async function refresh(initial = false) {
    loading = true;
    error = '';
    try {
      const result = await actions.load();
      if (alive) { snapshot = result; if (initial) role = result.defaultRole; }
    } catch (e) { if (alive) error = String(e); }
    finally { if (alive) loading = false; }
  }
  async function create(event: SubmitEvent) {
    event.preventDefault();
    if (busy || loading) return;
    busy = true; error = ''; link = ''; copied = false;
    try {
      const token = await actions.create(label.trim(), role);
      if (!alive) return;
      link = sharingUrl(token, request.path);
      await refresh();
    } catch (e) { if (alive) error = `Could not confirm link creation. Check Who has access before trying again. ${String(e)}`; }
    finally { if (alive) busy = false; }
  }
  async function update(grant: ShareGrant, revoke = false) {
    if (busy || loading) return;
    busy = true; error = '';
    try {
      await actions.update(grant.id, revoke ? { revoked: true } : { label: editLabel, ...(editRole !== grant.role ? { role: editRole } : {}) });
      if (!alive) return;
      editing = undefined; revoking = undefined;
      // Avoid displaying a freshly created URL after any revocation.
      if (revoke) link = '';
      await refresh();
    } catch (e) { if (alive) error = `Could not confirm the change. Refresh sharing before trying again. ${String(e)}`; }
    finally { if (alive) busy = false; }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(link); if (alive) copied = true; }
    catch { if (alive) error = 'Could not copy automatically. Select and copy the link below.'; }
  }
  function roleTitle(key: string) {
    return snapshot?.roles.find(role => role.key === key)?.title || (key === 'all' ? 'All permissions from sharer' : key === 'none' ? 'App default' : 'Custom permissions');
  }
</script>

<Modal bind:open title="Sharing" description={title} {busy} {returnFocus} wide>
  <div class="sharing">
  <Tabs.Root bind:value={tab}>
    <div class="tabs">
      <Tabs.List aria-label="Sharing views">
        <Tabs.Trigger value="share">Create link</Tabs.Trigger>
        <Tabs.Trigger value="access">Who has access</Tabs.Trigger>
      </Tabs.List>
    </div>
    {#if loading}<LoadingStatus label="Loading sharing…" />{/if}
    {#if snapshot}
      {#if !snapshot.private}<p>This grain uses legacy public access. Revoking a link does not make it private.</p>{/if}
      <Tabs.Content value="share">
        <form onsubmit={create}>
          <label>Link label<TextInput bind:value={label} maxlength={160} placeholder="For example: Project team" disabled={busy || loading} /></label>
          <label>Permissions<NativeSelect aria-label="Permissions" bind:value={role} disabled={busy || loading}>
            <option value="none">App default</option>
            {#each snapshot.roles as item}<option value={item.key}>{item.title}</option>{/each}
            <option value="all">All my permissions</option>
          </NativeSelect></label>
          {#if snapshot.roles.find(item => item.key === role)?.description}<p class="hint">{snapshot.roles.find(item => item.key === role)?.description}</p>{/if}
          <p class="hint">Anyone with this link can use and share it, with at most the permissions you have.</p>
          <div><Button type="submit" disabled={busy || loading}>{busy ? 'Working…' : 'Create link'}</Button></div>
        </form>
        {#if link}<div class="new-link" role="status">
          <label>New sharing link<TextInput value={link} readonly onclick={event => event.currentTarget.select()} /></label>
          <Button variant="secondary" onclick={copy}>{copied ? 'Copied' : 'Copy link'}</Button>
          <p class="hint">Copy this link now. Manage its label and permissions in Who has access.</p>
        </div>{/if}
      </Tabs.Content>
      <Tabs.Content value="access">
        <div class="access-heading">
          <p class="hint">{snapshot.owner ? 'You own this grain.' : 'Access downstream of your shares.'} People may have more than one grant.</p>
          <Button variant="secondary" disabled={busy || loading} onclick={() => refresh()}>Refresh sharing</Button>
        </div>
        <div class="table-scroll">
          <table aria-label="Current access">
            <thead><tr><th scope="col">Person or link</th><th scope="col">Permissions</th><th scope="col" class="actions-heading">Actions</th></tr></thead>
            <tbody>
              {#each snapshot.grants as grant (grant.id)}
                <tr>
                  <td><strong title={grant.kind === 'link' ? grant.label || 'Unlabeled link' : grant.recipient}>{grant.kind === 'link' ? grant.label || 'Unlabeled link' : grant.recipient}</strong>
                    <span class="detail">{grant.kind === 'link' ? 'Sharing link' : grant.kind === 'grain' ? 'Connected app' : grant.inherited ? 'Via sharing link' : 'Direct share'}{grant.kind !== 'link' && grant.label ? ' · ' + grant.label : ''}</span>
                  </td>
                  <td><span class="permission">{roleTitle(grant.role)}</span></td>
                  <td>
                    {#if grant.editable}<div class="row-actions">
                      <Button variant="secondary" disabled={busy || loading} onclick={() => { editing = grant; revoking = undefined; editLabel = grant.label; editRole = grant.role; }}>Edit</Button>
                      <Button variant="secondary" disabled={busy || loading} onclick={() => { revoking = grant; editing = undefined; }}>Revoke</Button>
                    </div>
                    {:else}<span class="detail" title={grant.inherited ? 'Revoke the source sharing link to remove access through it.' : 'Only the person who created this grant can change it.'}>{grant.inherited ? 'Manage source link' : 'Managed by sharer'}</span>{/if}
                  </td>
                </tr>
                {#if editing?.id === grant.id}<tr class="expanded"><td colspan="3">
                  <form onsubmit={event => { event.preventDefault(); void update(grant); }}>
                    <div class="edit-fields">
                      <label>Edit label<TextInput bind:value={editLabel} maxlength={160} disabled={busy} /></label>
                      <label>Edit permissions<NativeSelect aria-label="Edit permissions" bind:value={editRole} disabled={busy}>
                        {#if grant.role === 'custom'}<option value="custom">Custom permissions (unchanged)</option>{/if}
                        <option value="none">App default</option>
                        {#each snapshot.roles as item}<option value={item.key}>{item.title}</option>{/each}
                        <option value="all">All my permissions</option>
                      </NativeSelect></label>
                    </div>
                    <div class="actions"><Button type="submit" disabled={busy || loading}>Save changes</Button><Button variant="secondary" disabled={busy} onclick={() => { editing = undefined; }}>Cancel</Button></div>
                  </form>
                </td></tr>{/if}
                {#if revoking?.id === grant.id}<tr class="expanded"><td colspan="3">
                  <p>Revoke “{grant.label || grant.recipient}”? Everyone relying on this grant, including downstream recipients, will lose that access. Other independent grants still work.</p>
                  <div class="actions"><Button variant="danger" disabled={busy || loading} onclick={() => update(grant, true)}>Confirm revoke</Button><Button variant="secondary" disabled={busy} onclick={() => { revoking = undefined; }}>Cancel</Button></div>
                </td></tr>{/if}
              {:else}<tr><td colspan="3" class="empty">No shared access to show.</td></tr>{/each}
            </tbody>
          </table>
        </div>
        {#if snapshot.limited}<p class="hint">Showing the first 100 grants. Some access is not shown.</p>{/if}
      </Tabs.Content>
    {/if}
  </Tabs.Root>
  {#if error}<p role="alert">{error}</p>{#if !snapshot}<Button variant="secondary" disabled={loading} onclick={() => refresh(true)}>Retry</Button>{/if}{/if}
  <div class="footer"><Button variant="secondary" disabled={busy} onclick={() => { open = false; }}>Done</Button></div>
  </div>
</Modal>

<style>
  .sharing { --ss-control-height: 2.125rem; }
  .tabs { margin-bottom: var(--ss-space-4); border-bottom: 1px solid var(--ss-border); }
  .tabs :global([role=tablist]) { display: flex; gap: var(--ss-space-5); }
  .tabs :global([role=tab]) { border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; padding: var(--ss-space-2) 0; background: transparent; color: var(--ss-muted); font: 600 var(--ss-text-small)/1.5 var(--ss-font); cursor: pointer; }
  .tabs :global([role=tab][data-state=active]) { border-bottom-color: var(--ss-brand); color: var(--ss-brand); }
  .tabs :global([role=tab]:focus-visible) { outline: 2px solid var(--ss-focus); outline-offset: 3px; }
  form { display: grid; gap: var(--ss-space-2); }
  label { display: grid; gap: var(--ss-space-1); font-size: var(--ss-text-small); font-weight: 600; min-width: 0; }
  p { margin: 0; }
  .hint, .detail { color: var(--ss-muted); font-size: var(--ss-text-small); }
  .new-link { display: grid; gap: var(--ss-space-2); margin-top: var(--ss-space-4); padding: var(--ss-space-3); background: var(--ss-canvas); border: 1px solid var(--ss-border); }
  .actions, .row-actions, .footer, .access-heading { display: flex; align-items: center; gap: var(--ss-space-2); }
  .access-heading { justify-content: space-between; margin-bottom: var(--ss-space-3); }
  .access-heading > :global(.scope) { flex: none; }
  .table-scroll { overflow: auto; max-height: 48dvh; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: var(--ss-text-small); }
  th { position: sticky; top: 0; background: var(--ss-canvas); color: var(--ss-muted); text-align: left; font-weight: 600; }
  th, td { padding: var(--ss-space-2) var(--ss-space-3); border-bottom: 1px solid var(--ss-border); vertical-align: middle; }
  th:first-child { width: 43%; }
  th:last-child { width: 10rem; }
  td strong, .detail { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .permission { overflow-wrap: anywhere; }
  .row-actions { justify-content: flex-end; }
  .actions-heading { text-align: right; }
  .expanded td { background: var(--ss-canvas); padding: var(--ss-space-3); }
  .expanded p { margin-top: 0; }
  .edit-fields { display: grid; grid-template-columns: 1fr 1fr; gap: var(--ss-space-3); }
  .empty { text-align: center; padding: var(--ss-space-5); color: var(--ss-muted); }
  .footer { justify-content: flex-end; margin-top: var(--ss-space-4); }
  [role=alert] { color: var(--ss-danger); overflow-wrap: anywhere; }
  @media (max-width: 540px) {
    table { min-width: 30rem; }
    .edit-fields { grid-template-columns: 1fr; }
    .access-heading { align-items: flex-start; }
  }
</style>
