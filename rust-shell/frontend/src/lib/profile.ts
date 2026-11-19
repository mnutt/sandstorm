import type { ShellConnection } from './connection';
import { errorMessage } from './operations';

export interface Profile { name: string; handle: string; pronoun: string; mainHref: string }
export interface ProfileState {
  value: Profile | null;
  loading: boolean;
  saving: boolean;
  error: string;
  notice: string;
}
export const emptyProfile = (): ProfileState => ({ value: null, loading: false, saving: false, error: '', notice: '' });

export class ProfileService {
  private state = emptyProfile();
  private generation = 0;
  private read = 0;
  constructor(private connection: ShellConnection, private changed: (state: ProfileState) => void,
    private renamed: (name: string) => void) {}
  private update(patch: Partial<ProfileState>) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  reset(accountChanged = false) {
    ++this.generation;
    ++this.read;
    const error = this.state.saving ? 'Could not confirm profile save. Refresh and check your profile before saving again.' : this.state.error;
    this.state = { ...emptyProfile(), error: accountChanged ? '' : error,
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
      this.update({ value: this.decode(result.profile) });
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
      this.update({ value: this.decode(result.profile), notice: 'Profile saved.' });
      this.renamed(result.profile.name);
    } catch (error) {
      if (generation === this.generation) this.update({ error: `Could not confirm profile save. Refresh and check before saving again. ${errorMessage(error)}` });
    } finally { if (generation === this.generation) this.update({ saving: false }); }
  }
  private decode(profile: Profile): Profile {
    return { name: profile.name, handle: profile.handle, pronoun: profile.pronoun, mainHref: profile.mainHref };
  }
}
