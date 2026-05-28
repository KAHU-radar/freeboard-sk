/**
 * KAHU TrackServer connection config.
 *
 * Fill in KAHU_API_KEY with your API key UUID below, then run once:
 *   git update-index --skip-worktree src/kahu-config.ts
 * This tells git to ignore your local edit so the key never gets committed.
 *
 * The API key must have can_read_nearby=True set in the TrackServer admin.
 * Get yours at: https://crowdsource.kahu.earth/admin/kahu_models/apikey/
 */
export const KAHU_SERVER_URL = 'https://crowdsource.kahu.earth';
export const KAHU_API_KEY = ''; // <-- paste your API key UUID here
