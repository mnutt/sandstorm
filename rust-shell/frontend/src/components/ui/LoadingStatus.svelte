<script lang="ts">
  let { label = 'Loading…', detail = '' }: { label?: string; detail?: string } = $props();
</script>
<div class="loading-status" role="status" aria-live="polite" aria-atomic="true">
  <span class="spinner" aria-hidden="true"></span>
  <div><p class="label">{label}</p>{#if detail}<p class="detail">{detail}</p>{/if}</div>
</div>
<style>
  .loading-status { display: flex; align-items: center; gap: var(--ss-space-3); padding: var(--ss-space-4) 0; color: var(--ss-text); }
  .spinner { flex: none; width: 1.75rem; height: 1.75rem; border: 3px solid var(--ss-border); border-top-color: var(--ss-brand); border-radius: 50%; animation: spin .85s linear infinite; }
  p { margin: 0; }
  .label { font-size: var(--ss-text-small); font-weight: 600; }
  .detail { color: var(--ss-muted); font-size: .8125rem; margin-top: var(--ss-space-1); }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style>
