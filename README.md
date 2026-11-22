# Instagram Saved Review

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**, choose **Load unpacked**, and select this `chrome-extension` folder.
3. Sign in to the Instagram account that supplied the export. Open **Instagram Saved Review** from the Chrome extensions menu and choose your `saved_posts.json` file.
4. Select **One review tab** or **Five-tab queue**, then choose **Start review**.

## Review

Use the review bar on each saved Instagram item, or press **K** to keep, **D** to unsave, or **J** to **Review later**. Each successful action advances the queue. Review later makes no decision: it moves the item to the end of the list, after all other new items, in the order items were deferred. Deferring an item again moves it to the end again. Keep or Unsave removes it from that list. The counters show new items separately from items marked review later, and the queue completes only when every item has a final decision. If only one item remains, Review later is refused: **This is the last item left. Choose Keep or Unsave.** Choose **Pause review** in the extension popup to close its review tabs and resume later. Decisions and the review-later list are saved as you go. If you close Chrome, start a new review to continue from the remaining items in the same order.

Drag the grip on the review bar to move it. You can also focus the grip and use the arrow keys. The bar keeps its position across items and sessions.

Each video starts unmuted when it becomes current. Press **M** or click **Mute** to toggle sound for that item. One-tab mode reuses the review tab. Five-tab mode closes each reviewed tab as it advances, activates and unmutes the next one, and opens a muted replacement when another item is available. Review later also closes its tab in five-tab mode; the item returns later in a fresh tab. If Undo is available at the end of a review, the last tab stays open so you can use it. Chrome and Instagram control when the video actually loads and plays.

Unsave uses Instagram's visible bookmark and checks that it displays the unsaved state before advancing. This version recognizes English bookmark labels. If the extension cannot identify or verify the control, it leaves you on the item. You can try Instagram's bookmark directly or choose Review later.

Click **Undo** or press **Ctrl+Z** to reopen and save the most recently unsaved post or reel in the current review tab. Choose **Keep**, **Unsave**, or **Review later**, and the same tab returns to the item you were reviewing. Review later leaves the restored decision and Undo history untouched and defers the item as usual. The waiting tabs stay in place. Posts and reels share one five-item Undo history. A failed restore stays in the history so you can retry.

To check a creator's profile, open it from the item as usual. Use Chrome's **Back** button or **Return to review** in the extension popup to resume at the same item. Your waiting tabs stay in the queue.

Choose **Start from beginning** in the extension popup to review all still-saved items in export order, including kept items and items marked review later. This pass excludes previously unsaved and unavailable items. Review later moves an item to the end of this pass without changing its stored decision; an item you kept stays kept. Its decided counter increases for Keep, Unsave, or an automatic unavailable skip, and its review later counter shows the items currently deferred within the pass. Its counters start at zero, with the total set to the number of reviewable items still saved when the pass starts. If you pause, **Resume review** picks up where you left off with the same counters. Starting from the beginning again clears the pass's review-later list.

## Unavailable items

The extension automatically skips deleted or removed items in its review queue, including inactive waiting tabs in five-tab mode. It records **unavailable** as a separate final decision, removes the item from review-later lists, and continues without clicking Instagram or unsaving anything. Unavailable items count as handled in progress and are excluded from future review passes. Ordinary Instagram browsing and Undo tabs are excluded from detection.

Detection requires both no bookmark control and no visible media, plus the English error phrase **"this page isn't available"** (straight or curly apostrophes, with whitespace normalized), or a navigation response status of 404 where Chrome exposes it. The condition must still hold about 1.2 seconds later. Checks run about every 300 ms for up to 10 seconds and stop when media or a bookmark appears; evidence seen near the end of that window still gets its confirmation check. A lightweight observer remains on queue tabs: if Instagram later renders an error at the same URL, checks restart with the same safeguards. Chrome may throttle background timers. A merely loading page without either error signal is left alone.

Instagram sometimes redirects a saved post/reel permalink to the creator's profile, where it shows the unavailable error. The extension tracks that redirect only while opening its own queued permalink, before media or a bookmark has confirmed the item loaded. The exact redirected URL, sender, tab, and current browser URL must match before the same two-check detector can mark the original saved item unavailable. This works for waiting tabs as well. Ordinary profile clicks, already-loaded items, login/challenge destinations, and Undo are excluded; no permissions or network probes are added.

On the next available item you see, a small non-interactive note appears near the left edge for about four seconds. Multiple automatic skips are combined into one count. The note stays separate from the draggable review bar and respects reduced-motion settings. If the last item is unavailable, the same message appears in the finished panel instead.

If 10 items in a row look unavailable, with no intervening decision or newly shown available item, the review pauses automatically. Open the popup to read the explanation, check that you are logged in and Instagram is working, then resume. Items already marked unavailable stay marked. While paused, choose **Recheck unavailable items (N)** to make them pending again in their normal export order; this action is unavailable during a review or Undo. The popup shows the unavailable count only when it is nonzero. Reimporting preserves unavailable decisions for matching ids.

In one-tab mode, skipping an unavailable item keeps a tracked queue slot while navigating to the next item. If Chrome cannot navigate, the queue remains resumable and the review bar and extension popup show the failure. Choose **Return to review** to retry without recording the unavailable item a second time. Return to review also refills an empty queue left by an interrupted handoff in an older version.

The extension imports unique Instagram posts, including photos, carousels and videos, as well as reels and legacy IGTV links. Reimporting preserves decisions for matching items and the recent Undo history, and keeps the order of deferred items that are still present and pending. Importing ends any re-review pass. Existing progress from earlier versions is migrated once: the old J action becomes pending review-later items in export order after any items already deferred. The export file stays on your machine.
