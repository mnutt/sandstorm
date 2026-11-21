<script lang="ts">
  let { src = '', name = '', size = 20 }: { src?: string; name?: string; size?: number } = $props();
  let failedSource = $state<string>();
  const initials = $derived(name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0] || '').join('').toLocaleUpperCase());
</script>

<span class="avatar" style:width={`${size}px`} style:height={`${size}px`} style:font-size={`${size * .42}px`} aria-hidden="true">
  {#if src && failedSource !== src}
    <img {src} alt="" width={size} height={size} referrerpolicy="no-referrer" onerror={() => failedSource = src} />
  {:else if initials}{initials}
  {:else}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="8" r="3.5" /><path d="M5 21v-3a7 7 0 0 1 14 0v3" /></svg>
  {/if}
</span>

<style>
  .avatar { display: inline-flex; align-items: center; justify-content: center; flex: none; vertical-align: middle; overflow: hidden; border-radius: 2px; background: #88769a33; color: inherit; font-weight: 600; line-height: 1; }
  img { display: block; width: 100%; height: 100%; object-fit: cover; }
  svg { width: 75%; height: 75%; }
</style>
