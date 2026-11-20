import type { ShellConnection } from './connection';
import { ProfilePronoun, type AccountProfile } from '../generated/shell';
import { unwrap, ApplicationError } from './results';

class ProfileInputError extends Error {}
function profileError(error: unknown, fallback: string) {
  return error instanceof ProfileInputError || error instanceof ApplicationError ? error.message : fallback;
}
const pronouns: Record<string, ProfilePronoun> = {neutral:ProfilePronoun.NEUTRAL,male:ProfilePronoun.MALE,female:ProfilePronoun.FEMALE,robot:ProfilePronoun.ROBOT};
function wirePronoun(value: string): ProfilePronoun {
  if (!Object.hasOwn(pronouns,value)) throw new ProfileInputError('Choose a pronoun option.');
  return pronouns[value];
}

export interface Profile { name: string; handle: string; pronoun: string; pictureUrl: string; version: string }
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
    this.update({ loading: true, error: '' });
    try {
      const result = await this.connection.run(this.connection.account.readProfile().promise(), 'Load profile');
      if (generation !== this.generation || read !== this.read) return;
      const profile = unwrap(result.result);
      this.update({ value: this.decode(profile), stale:this.staleFor(profile.version) });
      this.renamed(profile.name);
    } catch (error) {
      if (generation === this.generation && read === this.read) this.update({ error: profileError(error, 'Could not load your profile. Please try again.') });
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
      const result = await this.connection.run(this.connection.account.updateProfile(params => {
        const edit = params._initProfile();
        edit.name = profile.name;
        edit.handle = profile.handle;
        edit.pronoun = wirePronoun(profile.pronoun);
      }).promise(), 'Save profile');
      if (generation !== this.generation) return;
      const updated = unwrap(result.result);
      this.update({ value: this.decode(updated), notice: 'Profile saved.', stale:this.staleFor(updated.version) });
      this.renamed(updated.name);
    } catch (error) {
      if (generation === this.generation) this.update({ stale:this.staleFor(this.state.value?.version || ''), error: profileError(error, 'Could not confirm profile save. Refresh and check before saving again.') });
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
      if (image.type !== 'image/jpeg' || image.size > 65536 || !image.size) throw new ProfileInputError('Choose an image and wait for its preview before uploading.');
      if (generation !== this.generation) return;
      lifetime.throwIfAborted();
      const result = await this.connection.run(this.connection.account.preparePictureUpload().promise(), 'Prepare picture upload');
      if (generation !== this.generation) return;
      const upload = unwrap(result.result);
      const signal = AbortSignal.any([lifetime, AbortSignal.timeout(30000)]);
      signal.throwIfAborted();
      sent = true;
      const response = await fetch(upload.url, {method:'POST',body:image,credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',signal});
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) throw new ProfileInputError('The server rejected the image. Choose an image and try uploading again.');
        throw new Error('Picture upload failed.');
      }
      if (generation !== this.generation) return;
      const refreshed = await this.connection.run(this.connection.account.readProfile().promise(), 'Refresh profile picture');
      if (generation !== this.generation) return;
      const profile = unwrap(refreshed.result);
      this.update({value:this.decode(profile),pictureNotice:'Profile picture updated.',stale:this.staleFor(profile.version)});
    } catch (error) {
      if (generation === this.generation) this.update({stale:this.staleFor(this.state.value?.version || ''),pictureError:sent && !(error instanceof ProfileInputError) ? 'Could not confirm picture upload. Check your picture before trying again.' : profileError(error, 'Could not prepare picture upload. Please try again.')});
    } finally { if (generation === this.generation) this.update({saving:false,pictureSaving:false}); }
  }
  private decode(profile: AccountProfile): Profile {
    const pronoun = Object.keys(pronouns).find(key => pronouns[key] === profile.pronoun);
    if (!pronoun) throw new Error('Invalid profile pronoun.');
    return { name: profile.name, handle: profile.handle, pronoun, pictureUrl: profile.pictureUrl, version: profile.version };
  }
}
