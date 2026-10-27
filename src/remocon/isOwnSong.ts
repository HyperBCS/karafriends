import type { SharedQueueItem } from "../common/api";

// The server's rule for supervised mode (owns() in src/main/api.ts): a song
// is yours if this phone queued it, or someone with your nickname did.
export default function isOwnSong(
  item: SharedQueueItem,
  nickname: string,
): boolean {
  return item.isMine || item.user.nickname === nickname;
}
