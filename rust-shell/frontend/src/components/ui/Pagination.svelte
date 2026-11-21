<script lang="ts">
  import Button from './Button.svelte';
  let {page, more, busy = false, label, change}: {page:number; more:boolean; busy?:boolean; label:string; change:(page:number)=>void} = $props();
</script>
{#if page > 0 || more}
  <nav aria-label={label + ' pages'} aria-busy={busy}>
    <Button variant="secondary" disabled={busy || page === 0} onclick={() => change(page - 1)}>Previous</Button>
    <span role="status">{busy ? 'Loading…' : `Page ${page + 1}`}</span>
    <Button variant="secondary" disabled={busy || !more} onclick={() => change(page + 1)}>Next</Button>
  </nav>
{/if}
<style>
  nav { display:flex; align-items:center; justify-content:center; gap:.75rem; padding:.75rem; font-size:var(--ss-text-small); }
</style>
