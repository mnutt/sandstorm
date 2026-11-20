<script lang="ts">
  import { onMount } from 'svelte';
  import Panel from './components/ui/Panel.svelte';
  onMount(() => { window.close(); });
</script>
<Panel><h2>Authorization returned</h2><p>You can close this window and return to the original Sandstorm tab.</p></Panel>
