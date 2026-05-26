/**
 * Example skill: notify on post saved (afterPostSaved hook)
 * Copy this file to ~/.pinpawo/skills/notify.mjs to enable it.
 *
 * Sends a macOS notification when the pet publishes a new post.
 */
import { exec } from 'node:child_process';

export default {
  name: 'notify',
  description: 'Send a macOS notification when a post is published',
  hooks: {
    afterPostSaved: async (postId, payload) => {
      const msg = payload.content.slice(0, 60).replace(/"/g, '\\"');
      exec(`osascript -e 'display notification "${msg}" with title "PinPawo 发了新动态"'`);
      console.log(`[notify] notified for post ${postId}`);
    },
  },
};
