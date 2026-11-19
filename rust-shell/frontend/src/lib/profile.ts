import type { ShellConnection } from './connection';
import { errorMessage } from './operations';

export interface Profile { name: string; handle: string; pronoun: string; mainHref: string; pictureUrl: string; version: string }
export interface ProfileState {
  value: Profile | null;
  stale: boolean;
  pictureError: string;
  pictureNotice: string;
  pictureSaving: boolean;
  loading: boolean;
  saving: boolean;
  error: string;
  notice: string;
}
export const emptyProfile = (): ProfileState => ({ stale:false, pictureError:'', pictureNotice:'', pictureSaving:false, value: null, loading: false, saving: false, error: '', notice: '' });

export class ProfileService {
  private state = emptyProfile();
  private generation = 0;
  private read = 0;
  private observedVersions: string[] = [];
  private staleFor(version: string) {
    return !!version && this.observedVersions.includes(version) && this.observedVersions.at(-1) !== version;
  }
  constructor(private connection: ShellConnection, private changed: (state: ProfileState) => void,
    private renamed: (name: string) => void) {}
  private update(patch: Partial<ProfileState>) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  observe(version: string) {
    if (!version || this.observedVersions.at(-1) === version) return;
    this.observedVersions.push(version);
    if (this.observedVersions.length > 32) this.observedVersions.shift();
    if (this.state.value && !this.state.saving) this.update({stale: version !== this.state.value.version});
  }
  reset(accountChanged = false) {
    this.observedVersions = [];
    ++this.generation;
    ++this.read;
    const error = this.state.saving && !this.state.pictureSaving ? 'Could not confirm profile save. Refresh and check your profile before saving again.' : this.state.error;
    this.state = { ...emptyProfile(), pictureError: accountChanged ? '' : this.state.pictureSaving ? 'Could not confirm picture upload. Check your picture before trying again.' : this.state.pictureError, error: accountChanged ? '' : error,
      notice: accountChanged ? '' : this.state.notice };
    this.changed(this.state);
  }
  async load() {
    if (this.state.saving) return;
    const generation = this.generation;
    const read = ++this.read;
    this.update({ loading: true });
    try {
      const result = await this.connection.run(this.connection.shell.getProfile().promise(), 'Load profile');
      if (generation !== this.generation || read !== this.read) return;
      this.update({ value: this.decode(result.profile), stale:this.staleFor(result.profile.version) });
      this.renamed(result.profile.name);
    } catch (error) {
      if (generation === this.generation && read === this.read) this.update({ error: errorMessage(error) });
    } finally {
      if (generation === this.generation && read === this.read) this.update({ loading: false });
    }
  }
  async save(profile: Pick<Profile, 'name' | 'handle' | 'pronoun'>) {
    if (this.state.saving) return;
    const generation = this.generation;
    ++this.read;
    this.update({ saving: true, loading: false, error: '', notice: '' });
    try {
      const result = await this.connection.run(this.connection.shell.updateProfile(params => {
        params.name = profile.name;
        params.handle = profile.handle;
        params.pronoun = profile.pronoun;
      }).promise(), 'Save profile');
      if (generation !== this.generation) return;
      this.update({ value: this.decode(result.profile), notice: 'Profile saved.', stale:this.staleFor(result.profile.version) });
      this.renamed(result.profile.name);
    } catch (error) {
      if (generation === this.generation) this.update({ stale:this.staleFor(this.state.value?.version || ''), error: `Could not confirm profile save. Refresh and check before saving again. ${errorMessage(error)}` });
    } finally { if (generation === this.generation) this.update({ saving: false }); }
  }
  async uploadPicture(image: Blob) {
    if (this.state.saving) return;
    const generation = this.generation;
    const lifetime = this.connection.signal;
    ++this.read;
    this.update({ saving:true, pictureSaving:true, loading:false, pictureError:'', pictureNotice:'' });
    let sent = false;
    try {
      if (image.type !== 'image/jpeg' || image.size > 65536 || !image.size) throw new Error('Choose an image and wait for its preview before uploading.');
      if (generation !== this.generation) return;
      lifetime.throwIfAborted();
      const result = await this.connection.run(this.connection.shell.uploadPicture().promise(), 'Prepare picture upload');
      if (generation !== this.generation) return;
      const signal = AbortSignal.any([lifetime, AbortSignal.timeout(30000)]);
      signal.throwIfAborted();
      sent = true;
      const response = await fetch(result.uploadUrl, {method:'POST',body:image,credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',signal});
      if (!response.ok) throw new Error('The server rejected the image. Use a PNG or JPEG no larger than 64 KiB.');
      if (generation !== this.generation) return;
      const refreshed = await this.connection.run(this.connection.shell.getProfile().promise(), 'Refresh profile picture');
      if (generation !== this.generation) return;
      this.update({value:this.decode(refreshed.profile),pictureNotice:'Profile picture updated.',stale:this.staleFor(refreshed.profile.version)});
    } catch (error) {
      if (generation === this.generation) this.update({stale:this.staleFor(this.state.value?.version || ''),pictureError:sent ? `Could not confirm picture upload. Check your picture before trying again. ${errorMessage(error)}` : errorMessage(error)});
    } finally { if (generation === this.generation) this.update({saving:false,pictureSaving:false}); }
  }
  private decode(profile: Profile): Profile {
    return { name: profile.name, handle: profile.handle, pronoun: profile.pronoun, mainHref: profile.mainHref, pictureUrl: profile.pictureUrl || '', version: profile.version || '' };
  }
}
